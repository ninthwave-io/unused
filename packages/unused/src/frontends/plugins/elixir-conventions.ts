/** Compiled-in Elixir conventions prepared from one bounded frontend inventory. */

import { relative, sep } from "node:path";
import {
  defineElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryProvider,
} from "../elixir/atom-role-summaries.js";
import { extractElixirScriptCommandRoots } from "../elixir/script-references.js";
import type { ConventionPlugin, GraphContribution, RepositoryAnalysisContext } from "./types.js";

const repositoryScriptRootCache = new WeakMap<
  RepositoryAnalysisContext,
  Promise<GraphContribution>
>();

const ectoOrigin = { pluginId: "convention:ecto", hexPackage: "ecto" } as const;
const propagate = "propagate-to-result" as const;
const consume = "consume-data" as const;
const selector = "invocation-selector" as const;
const ectoSummary = (
  module: string,
  name: string,
  arity: number,
  roles: Parameters<typeof defineElixirAtomRoleSummary>[3],
  implicitCallbackAudit?: NonNullable<
    Parameters<typeof defineElixirAtomRoleSummary>[4]
  >["implicitCallbackAudit"],
) =>
  defineElixirAtomRoleSummary(module, name, arity, roles, {
    origin: ectoOrigin,
    ...(implicitCallbackAudit === undefined ? {} : { implicitCallbackAudit }),
  });
const ectoCallback = (inputArguments: readonly number[], documentation: `https://${string}`) => ({
  inputArguments,
  documentation,
});
const CHANGESET_CALLBACK_SOURCE =
  "https://github.com/elixir-ecto/ecto/blob/v3.14.1/lib/ecto/changeset.ex" as const;
const TYPE_CALLBACK_SOURCE =
  "https://github.com/elixir-ecto/ecto/blob/v3.14.1/lib/ecto/type.ex" as const;
const release = (version: string, innerChecksum: string, outerChecksum: string) => ({
  version,
  innerChecksum,
  outerChecksum,
});
const ECTO_3_14_1_RELEASE = release(
  "3.14.1",
  "7b740d87bdf45996aa0c2c2e081640906f10caa7ce5ba328fd294c7d49d0cc6f",
  "24b991956796700f467d0a3ef3d303138a3ef9ddddf8b98f43758ee067b20a30",
);
const ECTO_ADD_ERROR_HISTORICAL_RELEASES = [
  release(
    "3.12.0",
    "9014a3ccac7f91e680b9d237d461ebe3d4e16d62ca8e355d540e2c6afdc28309",
    "41e781a76e131093af8e1edf68b1319bf320878faff58da41ffa4b10fc6ff678",
  ),
  release(
    "3.12.1",
    "626765f7066589de6fa09e0876a253ff60c3d00870dd3a1cd696e2ba67bfceea",
    "df0045ab9d87be947228e05a8d153f3e06e0d05ab10c3b3cc557d2f7243d1940",
  ),
  release(
    "3.12.2",
    "bae2094f038e9664ce5f089e5f3b6132a535d8b018bd280a485c2f33df5c0ce1",
    "492e67c70f3a71c6afe80d946d3ced52ecc57c53c9829791bfff1830ff5a1f0c",
  ),
  release(
    "3.12.3",
    "1a9111560731f6c3606924c81c870a68a34c819f6d4f03822f370ea31a582208",
    "9efd91506ae722f95e48dc49e70d0cb632ede3b7a23896252a60a14ac6d59165",
  ),
  release(
    "3.12.4",
    "267c94d9f2969e6acc4dd5e3e3af5b05cdae89a4d549925f3008b2b7eb0b93c3",
    "ef04e4101688a67d061e1b10d7bc1fbf00d1d13c17eef08b71d070ff9188f747",
  ),
  release(
    "3.12.5",
    "4a312960ce612e17337e7cefcf9be45b95a3be6b36b6f94dfb3d8c361d631866",
    "6eb18e80bef8bb57e17f5a7f068a1719fbda384d40fc37acb8eb8aeca493b6ea",
  ),
  release(
    "3.12.6",
    "8bf762dc5b87d85b7aca7ad5fe31ef8142a84cea473a3381eb933bd925751300",
    "4c0cba01795463eebbcd9e4b5ef53c1ee8e68b9c482baef2a80de5a61e7a57fe",
  ),
  release(
    "3.13.0",
    "7528ef4f3a4cdcfebeb7eb6545806c8109529b385a69f701fc3d77b5b8bde6e7",
    "061f095f1cc097f71f743b500affc792d6869df22b1946a73ab5495eb9b4a280",
  ),
  release(
    "3.13.1",
    "ebb11c2f0307ff62e8aaba57def59ad920a3cbd89d002b1118944cbf598c13c7",
    "d9ea5075a6f3af9cd2cdbabe8a0759eb73b485e981fd7c03014f79479ac85340",
  ),
  release(
    "3.13.2",
    "7d0c0863f3fc8d71d17fc3ad3b9424beae13f02712ad84191a826c7169484f01",
    "669d9291370513ff56e7b7e7081b7af3283d02e046cf3d403053c557894a0b3e",
  ),
  release(
    "3.13.3",
    "6a983f0917f8bdc7a89e96f2bf013f220503a0da5d8623224ba987515b3f0d80",
    "1927db768f53a88843ff25b6ba7946599a8ca8a055f69ad8058a1432a399af94",
  ),
  release(
    "3.13.4",
    "27834b45d58075d4a414833d9581e8b7bb18a8d9f264a21e42f653d500dbeeb5",
    "5ad7d1505685dfa7aaf86b133d54f5ad6c42df0b4553741a1ff48796736e88b2",
  ),
  release(
    "3.13.5",
    "9d4a69700183f33bf97208294768e561f5c7f1ecf417e0fa1006e4a91713a834",
    "df9efebf70cf94142739ba357499661ef5dbb559ef902b68ea1f3c1fabce36de",
  ),
  release(
    "3.13.6",
    "352135b474f91d1ab99a1b502171d207e9db60421c9e3d0ecab4c7ab96b24d14",
    "8afa059bc16cd2c94739ec0a11e3e5df69d828125119109bef35f20a21a76af2",
  ),
  release(
    "3.14.0",
    "2fa64521eebfcb2670d907a86e4ad947290e9933706bb315e6fb5c21b172cb26",
    "130d69ffb4285f9ce4792b65dfbb994fd13ea4cbc3cbea2524b199aa3de84af3",
  ),
] as const;
export const ECTO_ADD_ERROR_AUDITED_RELEASES = [
  ...ECTO_ADD_ERROR_HISTORICAL_RELEASES,
  ECTO_3_14_1_RELEASE,
] as const;
export const ECTO_ADD_ERROR_AUDITED_VERSIONS = ECTO_ADD_ERROR_AUDITED_RELEASES.map(
  (audited) => audited.version,
);
const ectoAddErrorSummaries = [
  ectoSummary("Ecto.Changeset", "add_error", 3, {
    0: propagate,
    1: propagate,
  }),
  ectoSummary("Ecto.Changeset", "add_error", 4, {
    0: propagate,
    1: propagate,
    3: propagate,
  }),
] as const;

/** Semantic summaries owned by the compiled-in Ecto convention plugin. */
export const ectoElixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider = {
  id: "convention:ecto",
  compilerApp: "ecto",
  otpApp: "ecto",
  lockKey: "ecto",
  hexPackage: "ecto",
  repository: "hexpm",
  // `ecto-3.14.1.tar`: archive CHECKSUM plus whole-tar/API checksum.
  auditedReleases: [ECTO_3_14_1_RELEASE],
  summaries: [
    ectoSummary("Ecto.Changeset", "change", 1, {}, ectoCallback([0], CHANGESET_CALLBACK_SOURCE)),
    ectoSummary("Ecto.Changeset", "change", 2, {}, ectoCallback([0, 1], CHANGESET_CALLBACK_SOURCE)),
    ectoSummary(
      "Ecto.Changeset",
      "cast",
      3,
      {},
      ectoCallback([0, 1, 2], CHANGESET_CALLBACK_SOURCE),
    ),
    ectoSummary(
      "Ecto.Changeset",
      "cast",
      4,
      {},
      ectoCallback([0, 1, 2, 3], CHANGESET_CALLBACK_SOURCE),
    ),
    ectoSummary(
      "Ecto.Changeset",
      "put_change",
      3,
      { 1: propagate },
      ectoCallback([0, 2], CHANGESET_CALLBACK_SOURCE),
    ),
    ectoSummary("Ecto.Changeset", "force_change", 3, {
      0: propagate,
      1: propagate,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "delete_change", 2, { 0: propagate, 1: consume }),
    ectoSummary("Ecto.Changeset", "get_change", 2, { 0: propagate, 1: consume }),
    ectoSummary("Ecto.Changeset", "get_change", 3, {
      0: propagate,
      1: consume,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "get_field", 2, { 0: propagate, 1: consume }),
    ectoSummary("Ecto.Changeset", "get_field", 3, {
      0: propagate,
      1: consume,
      2: propagate,
    }),
    ectoSummary(
      "Ecto.Changeset",
      "validate_inclusion",
      3,
      { 1: propagate },
      ectoCallback([0, 2], CHANGESET_CALLBACK_SOURCE),
    ),
    ectoSummary(
      "Ecto.Changeset",
      "validate_inclusion",
      4,
      { 1: propagate, 3: propagate },
      ectoCallback([0, 2], CHANGESET_CALLBACK_SOURCE),
    ),
    ectoSummary("Ecto.Changeset", "apply_changes", 1, { 0: propagate }),
    ...ectoAddErrorSummaries,
    ectoSummary("Ecto.Type", "cast", 2, { 0: selector }, ectoCallback([1], TYPE_CALLBACK_SOURCE)),
    ectoSummary("Ecto.Type", "load", 2, { 0: selector }, ectoCallback([1], TYPE_CALLBACK_SOURCE)),
    ectoSummary("Ecto.Type", "dump", 2, { 0: selector }, ectoCallback([1], TYPE_CALLBACK_SOURCE)),
    ectoSummary(
      "Ecto.Type",
      "equal?",
      3,
      { 0: selector },
      ectoCallback([1, 2], TYPE_CALLBACK_SOURCE),
    ),
    ectoSummary(
      "Ecto.Type",
      "embed_as",
      2,
      { 0: selector },
      ectoCallback([1], TYPE_CALLBACK_SOURCE),
    ),
    ectoSummary("Ecto.Type", "type", 1, { 0: selector }, ectoCallback([], TYPE_CALLBACK_SOURCE)),
  ],
  additionalReleaseGroups: [
    {
      auditedReleases: ECTO_ADD_ERROR_HISTORICAL_RELEASES,
      summaries: ectoAddErrorSummaries,
    },
  ],
};

/** Registered pre-graph convention capability; it has no post-graph additions. */
export const ectoElixirConventionPlugin: ConventionPlugin & {
  readonly elixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider;
} = {
  kind: "convention",
  id: "convention:ecto",
  version: "0.1.0",
  languages: ["ex"],
  elixirAtomRoleSummaryProvider: ectoElixirAtomRoleSummaryProvider,
  applies: () => false,
  async analyze() {
    return {};
  },
};

export const elixirRuntimeConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:elixir-runtime",
  version: "0.1.0",
  languages: ["ex"],
  applies(context) {
    return context.fragment.deferredContributions?.has(this.id) === true;
  },
  async analyze(context) {
    return context.fragment.deferredContributions?.get(this.id) ?? {};
  },
};

export const elixirScriptConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:elixir-scripts",
  version: "0.1.0",
  languages: ["ex"],
  applies(context) {
    return context.fragment.deferredContributions?.has(this.id) === true;
  },
  async analyze(context) {
    const prepared = context.fragment.deferredContributions?.get(this.id) ?? {};
    const scriptFiles = new Set(
      (prepared.nodes ?? []).filter((node) => node.kind === "file").map((node) => node.path),
    );
    const roots = await repositoryScriptRoots(context.repository);
    const nodes = new Map((prepared.nodes ?? []).map((node) => [node.id, node]));
    for (const node of roots.nodes ?? []) {
      if (node.kind === "entrypoint" && scriptFiles.has(node.file)) nodes.set(node.id, node);
    }
    return {
      nodes: [...nodes.values()],
      ...(prepared.edges === undefined ? {} : { edges: prepared.edges }),
      ...(prepared.hazards === undefined ? {} : { hazards: prepared.hazards }),
      ...(prepared.diagnostics === undefined ? {} : { diagnostics: prepared.diagnostics }),
    };
  },
};

function repositoryScriptRoots(repository: RepositoryAnalysisContext): Promise<GraphContribution> {
  const cached = repositoryScriptRootCache.get(repository);
  if (cached !== undefined) return cached;
  const scripts = new Set(
    repository.manifests.elixirSourceFiles
      .map((file) => relative(repository.rootDir, file).split(sep).join("/"))
      .filter(
        (file) =>
          file.endsWith(".exs") &&
          file !== ".." &&
          !file.startsWith("../") &&
          !file.startsWith("/"),
      ),
  );
  const roots = extractElixirScriptCommandRoots(repository.rootDir, scripts, repository.gitignore);
  repositoryScriptRootCache.set(repository, roots);
  return roots;
}
