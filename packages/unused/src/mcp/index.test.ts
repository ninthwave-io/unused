/**
 * MCP server integration tests (T8.3, docs/phasing.md M8). These spawn the
 * built `dist/cli/index.js mcp` as a real child process and drive it with the
 * official SDK's `Client` over stdio — the honest test of the wire contract
 * (PRD §5): tool discovery, the three tool shapes, `find_unused` schema parity
 * with `--json`, `why_alive` on alive / dead / test-only subjects, and
 * `usage_evidence`'s explicit not-configured slots.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { configSignature } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const TSC_BIN = join(REPO_ROOT, "node_modules/.bin/tsc");
const CLI_ENTRY = join(PACKAGE_ROOT, "dist/cli/index.js");
const FIXTURES_ROOT = join(REPO_ROOT, "fixtures/ts");
const DEAD_FIXTURE = join(FIXTURES_ROOT, "basic-dead-export"); // alive `add`, dead `subtract`
const TEST_ONLY_FIXTURE = join(FIXTURES_ROOT, "test-root-recognition"); // test-only src/feature.ts

beforeAll(() => {
  execFileSync(TSC_BIN, ["-p", join(PACKAGE_ROOT, "tsconfig.json")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}, 120_000);

/** One spawn/connect/run/close cycle against a freshly-spawned server. */
async function runMcpOnce<T>(fixture: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "mcp", "--cwd", fixture],
    stderr: "ignore",
  });
  const client = new Client({ name: "unused-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    // Await the close so the child's stdio is fully torn down before the next
    // spawn; swallow a close-time error (a teardown race can surface as
    // "Connection closed" here) so it never masks a successful `fn` result.
    await client.close().catch(() => {});
  }
}

/**
 * Is `err` a transient stdio child-process teardown/startup race rather than a
 * real contract failure? The MCP SDK surfaces such races as an `McpError`
 * "Connection closed" (JSON-RPC code -32000) or a raw pipe error (EPIPE/
 * ECONNRESET) when the spawned server's stdio closes at an unlucky moment.
 */
function isTransientMcpError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /connection closed|-32000|epipe|econnreset/i.test(msg);
}

/**
 * Spawn `unused mcp --cwd <fixture>`, connect an SDK client, run `fn`, then close.
 * Retries the whole spawn ONCE on a transient stdio teardown/startup race
 * (documented flake, not a product bug — see {@link isTransientMcpError}); a
 * single clean re-spawn is reliable, and a genuine contract failure still
 * propagates on the first non-transient error.
 */
async function withMcpClient<T>(fixture: string, fn: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await runMcpOnce(fixture, fn);
  } catch (err) {
    if (!isTransientMcpError(err)) throw err;
    return await runMcpOnce(fixture, fn);
  }
}

/** Parse the JSON payload out of a tool result's first text content block. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text: string }[] }).content;
  const text = content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool result had no text content");
  return JSON.parse(text) as Record<string, unknown>;
}

interface ClaimLike {
  id: string;
  provenance: { generatedAt: string };
}

/** Strip the only run-varying field (the wall-clock stamp) so two independent analyses compare equal. */
function normalizeClaims(claims: readonly ClaimLike[]): unknown[] {
  return claims.map((c) => ({ ...c, provenance: { ...c.provenance, generatedAt: "T" } }));
}

describe("MCP server — tool discovery", () => {
  it("lists exactly the three PRD §5 tools", async () => {
    const names = await withMcpClient(DEAD_FIXTURE, async (client) => {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name).sort();
    });
    expect(names).toEqual(["find_unused", "usage_evidence", "why_alive"]);
  });

  it("describes test-only evidence as environment-specific with real root provenance", async () => {
    const description = await withMcpClient(DEAD_FIXTURE, async (client) => {
      const { tools } = await client.listTools();
      return tools.find((tool) => tool.name === "why_alive")?.description;
    });
    expect(description).toContain("alive only in the effective test environment");
    expect(description).toContain("actual root kind and reason");
  });
});

describe("MCP config staleness signature", () => {
  it("changes for applicable ancestor and nested .gitignore edits", async () => {
    const repository = await mkdtemp(join(tmpdir(), "unused-mcp-gitignore-"));
    const root = join(repository, "packages", "app");
    try {
      await mkdir(join(repository, ".git"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      const ancestor = join(repository, ".gitignore");
      await writeFile(ancestor, "packages/app/src/generated.ts\n");
      const before = await configSignature(root);

      await writeFile(ancestor, "packages/app/src/generated.ts\npackages/app/src/cache.ts\n");
      const future = new Date(Date.now() + 5_000);
      await utimes(ancestor, future, future);
      const ancestorChanged = await configSignature(root);
      expect(ancestorChanged).not.toBe(before);

      await writeFile(join(root, "src/.gitignore"), "*.generated.ts\n");
      const nestedChanged = await configSignature(root);
      expect(nestedChanged).not.toBe(ancestorChanged);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("watches discovery-relevant hidden directories without traversing .git", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-mcp-hidden-config-"));
    try {
      await mkdir(join(root, ".storybook"), { recursive: true });
      await mkdir(join(root, ".github", "workflows"), { recursive: true });
      await mkdir(join(root, ".git", "internal"), { recursive: true });
      const before = await configSignature(root);

      await writeFile(join(root, ".storybook", ".gitignore"), "generated.ts\n");
      const storybookChanged = await configSignature(root);
      expect(storybookChanged).not.toBe(before);

      await writeFile(join(root, ".github", "workflows", ".gitignore"), "generated.yml\n");
      const workflowsChanged = await configSignature(root);
      expect(workflowsChanged).not.toBe(storybookChanged);

      await writeFile(join(root, ".git", "internal", ".gitignore"), "objects\n");
      expect(await configSignature(root)).toBe(workflowsChanged);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP server — find_unused", () => {
  it("returns claims at schema parity with `unused --json`", async () => {
    const cli = spawnSync(process.execPath, [CLI_ENTRY, "--json", "--cwd", DEAD_FIXTURE], {
      encoding: "utf8",
    });
    expect(cli.status).toBe(0);
    const jsonClaims = (JSON.parse(cli.stdout) as { claims: ClaimLike[] }).claims;

    const toolClaims = await withMcpClient(DEAD_FIXTURE, async (client) => {
      const res = await client.callTool({ name: "find_unused", arguments: {} });
      return payloadOf(res)["claims"] as ClaimLike[];
    });

    expect(toolClaims.length).toBeGreaterThan(0);
    expect(normalizeClaims(toolClaims)).toEqual(normalizeClaims(jsonClaims));
  });

  it("honours the kinds / minConfidence / paths filters", async () => {
    const claims = await withMcpClient(DEAD_FIXTURE, async (client) => {
      const res = await client.callTool({
        name: "find_unused",
        arguments: { kinds: ["export"], minConfidence: "high", paths: ["src/"] },
      });
      return payloadOf(res)["claims"] as { subject: { kind: string; loc: { file: string } } }[];
    });
    for (const c of claims) {
      expect(c.subject.kind).toBe("export");
      expect(c.subject.loc.file.startsWith("src/")).toBe(true);
    }
  });
});

describe("MCP server — why_alive", () => {
  it("answers alive with a path + entrypointKind for a live export", async () => {
    const payload = await withMcpClient(DEAD_FIXTURE, async (client) =>
      payloadOf(await client.callTool({ name: "why_alive", arguments: { symbol: "add" } })),
    );
    expect(payload["alive"]).toBe(true);
    expect(payload["entrypointKind"]).toBe("production");
    expect(Array.isArray(payload["paths"])).toBe(true);
    expect((payload["paths"] as string[])[0]).toContain("(production entrypoint)");
    expect(payload["testOnly"]).toBe(false);
  });

  it("answers dead with verdict + confidence for a flagged export (documented extension)", async () => {
    const payload = await withMcpClient(DEAD_FIXTURE, async (client) =>
      payloadOf(await client.callTool({ name: "why_alive", arguments: { symbol: "subtract" } })),
    );
    expect(payload["alive"]).toBe(false);
    expect(payload["paths"]).toEqual([]);
    expect(payload["verdict"]).toBe("unused");
    expect(payload["confidence"]).toBe("high");
    expect(Array.isArray(payload["evidence"])).toBe(true);
  });

  it("answers alive-but-test-only for a production-dead, test-reachable subject", async () => {
    const payload = await withMcpClient(TEST_ONLY_FIXTURE, async (client) =>
      payloadOf(
        await client.callTool({ name: "why_alive", arguments: { symbol: "src/feature.ts" } }),
      ),
    );
    expect(payload["alive"]).toBe(true);
    expect(payload["testOnly"]).toBe(true);
    expect(payload["entrypointKind"]).toBe("test");
  });

  it("reports not-found for a nonexistent symbol", async () => {
    const payload = await withMcpClient(DEAD_FIXTURE, async (client) =>
      payloadOf(await client.callTool({ name: "why_alive", arguments: { symbol: "ghost" } })),
    );
    expect(payload["found"]).toBe(false);
    expect(payload["alive"]).toBe(false);
  });
});

describe("MCP server — usage_evidence", () => {
  it("returns static evidence plus explicit not-configured runtime + human-usage slots", async () => {
    const evidence = await withMcpClient(DEAD_FIXTURE, async (client) => {
      const res = await client.callTool({
        name: "usage_evidence",
        arguments: { endpoint: "subtract" },
      });
      return payloadOf(res)["evidence"] as { type: string; notConfigured?: boolean }[];
    });

    // Never an empty array (PRD §5): the two source slots are always present.
    const notConfigured = evidence.filter((e) => e.notConfigured === true);
    expect(notConfigured.map((e) => e.type).sort()).toEqual(["human-usage", "runtime"]);
    // The static-reachability evidence for the dead subject is carried through.
    expect(evidence.some((e) => e.type === "static-reachability")).toBe(true);
  });
});
