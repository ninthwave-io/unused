/** Declarative intra-function computed-atom roles for exact public Elixir APIs. */

export type ElixirAtomArgumentRole =
  | "consume-data"
  | "propagate-to-result"
  | "invocation-selector"
  | "escape";

export interface ElixirAtomRoleSummary {
  readonly module: string;
  readonly name: string;
  readonly arity: number;
  /** Sparse logical argument roles. Omitted positions fail closed as escape. */
  readonly arguments: Readonly<Record<number, ElixirAtomArgumentRole>>;
  /** Exact literal callback result roles, keyed by logical callback argument. */
  readonly callbackResults?: Readonly<Record<number, "propagate-to-result">>;
  /** Publicly audited arguments whose values/elements may enter each callback. */
  readonly callbackAudits?: Readonly<
    Record<
      number,
      {
        readonly inputArguments: readonly number[];
        readonly resultRole: "propagate-to-result" | "escape";
        readonly documentation: `https://${string}`;
      }
    >
  >;
  /** Callback/protocol inputs selected implicitly rather than by one fun argument. */
  readonly implicitCallbackAudit?: {
    readonly inputArguments: readonly number[];
    readonly documentation: `https://${string}`;
  };
  readonly origin:
    | { readonly pluginId: "language:elixir" }
    | { readonly pluginId: "convention:ecto"; readonly dependency: "ecto" };
}

export interface ElixirAtomRoleSummaryProvider {
  readonly id: "convention:ecto";
  readonly dependency: string;
  /** Exact dependency versions whose public semantics were audited. */
  readonly auditedVersions: readonly string[];
  readonly summaries: readonly ElixirAtomRoleSummary[];
}

const core = { pluginId: "language:elixir" } as const;
const consume = "consume-data" as const;
const propagate = "propagate-to-result" as const;
const ELIXIR_DOCS = "https://hexdocs.pm/elixir/1.20.2" as const;

export const defineElixirAtomRoleSummary = (
  module: string,
  name: string,
  arity: number,
  argumentRoles: Readonly<Record<number, ElixirAtomArgumentRole>>,
  options: {
    readonly callbackResults?: Readonly<Record<number, "propagate-to-result">>;
    readonly callbackAudits?: ElixirAtomRoleSummary["callbackAudits"];
    readonly implicitCallbackAudit?: ElixirAtomRoleSummary["implicitCallbackAudit"];
    readonly origin?: ElixirAtomRoleSummary["origin"];
  } = {},
): ElixirAtomRoleSummary => ({
  module,
  name,
  arity,
  arguments: argumentRoles,
  ...(options.callbackResults === undefined ? {} : { callbackResults: options.callbackResults }),
  ...(options.callbackAudits === undefined ? {} : { callbackAudits: options.callbackAudits }),
  ...(options.implicitCallbackAudit === undefined
    ? {}
    : { implicitCallbackAudit: options.implicitCallbackAudit }),
  origin: options.origin ?? core,
});
const summary = defineElixirAtomRoleSummary;
const callback = (
  argument: number,
  inputArguments: readonly number[],
  documentation: `https://${string}`,
  resultRole: "propagate-to-result" | "escape" = propagate,
): Pick<ElixirAtomRoleSummary, "callbackResults" | "callbackAudits"> => ({
  ...(resultRole === propagate ? { callbackResults: { [argument]: propagate } } : {}),
  callbackAudits: { [argument]: { inputArguments, resultRole, documentation } },
});
const implicitCallback = (
  inputArguments: readonly number[],
  documentation: `https://${string}`,
): Pick<ElixirAtomRoleSummary, "implicitCallbackAudit"> => ({
  implicitCallbackAudit: { inputArguments, documentation },
});

/**
 * Initial reviewed surface. It intentionally records result propagation:
 * storing an atom in a returned collection is not the same as consuming it.
 */
export const ELIXIR_ATOM_ROLE_SUMMARIES: readonly ElixirAtomRoleSummary[] = [
  defineElixirAtomRoleSummary("Map", "fetch", 2, { 0: propagate, 1: consume }),
  summary("Map", "fetch!", 2, { 0: propagate, 1: consume }),
  summary("Map", "get", 2, { 0: propagate, 1: consume }),
  summary("Map", "get", 3, { 0: propagate, 1: consume, 2: propagate }),
  summary("Map", "has_key?", 2, { 0: consume, 1: consume }),
  summary("Map", "delete", 2, { 0: propagate, 1: consume }),
  summary("Map", "put", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary("Map", "put_new", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary("Map", "replace", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary("Map", "replace!", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary(
    "Map",
    "get_lazy",
    3,
    { 0: propagate, 1: consume },
    callback(2, [], `${ELIXIR_DOCS}/Map.html#get_lazy/3`),
  ),
  summary(
    "Map",
    "put_new_lazy",
    3,
    { 0: propagate, 1: propagate },
    callback(2, [], `${ELIXIR_DOCS}/Map.html#put_new_lazy/3`),
  ),
  summary(
    "Map",
    "update",
    4,
    { 1: propagate, 2: propagate },
    callback(3, [0], `${ELIXIR_DOCS}/Map.html#update/4`),
  ),
  summary(
    "Map",
    "update!",
    3,
    { 1: propagate },
    callback(2, [0], `${ELIXIR_DOCS}/Map.html#update!/3`),
  ),
  summary(
    "Map",
    "get_and_update",
    3,
    { 1: propagate },
    callback(2, [0], `${ELIXIR_DOCS}/Map.html#get_and_update/3`),
  ),
  summary("Map", "merge", 2, { 0: propagate, 1: propagate }),
  summary("Map", "merge", 3, {}, callback(2, [0, 1], `${ELIXIR_DOCS}/Map.html#merge/3`)),
  summary("Map", "new", 1, {}, implicitCallback([0], `${ELIXIR_DOCS}/Enumerable.html`)),
  summary("Map", "new", 2, {}, callback(1, [0], `${ELIXIR_DOCS}/Map.html#new/2`)),

  summary("Keyword", "fetch", 2, { 0: propagate, 1: consume }),
  summary("Keyword", "fetch!", 2, { 0: propagate, 1: consume }),
  summary("Keyword", "get", 2, { 0: propagate, 1: consume }),
  summary("Keyword", "get", 3, { 0: propagate, 1: consume, 2: propagate }),
  summary("Keyword", "has_key?", 2, { 0: consume, 1: consume }),
  summary("Keyword", "delete", 2, { 0: propagate, 1: consume }),
  summary("Keyword", "put", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary("Keyword", "put_new", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary("Keyword", "replace", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary("Keyword", "replace!", 3, { 0: propagate, 1: propagate, 2: propagate }),
  summary(
    "Keyword",
    "get_lazy",
    3,
    { 0: propagate, 1: consume },
    callback(2, [], `${ELIXIR_DOCS}/Keyword.html#get_lazy/3`),
  ),
  summary(
    "Keyword",
    "put_new_lazy",
    3,
    { 0: propagate, 1: propagate },
    callback(2, [], `${ELIXIR_DOCS}/Keyword.html#put_new_lazy/3`),
  ),
  summary(
    "Keyword",
    "update",
    4,
    { 1: propagate, 2: propagate },
    callback(3, [0], `${ELIXIR_DOCS}/Keyword.html#update/4`),
  ),
  summary(
    "Keyword",
    "update!",
    3,
    { 1: propagate },
    callback(2, [0], `${ELIXIR_DOCS}/Keyword.html#update!/3`),
  ),
  summary("Keyword", "merge", 2, { 0: propagate, 1: propagate }),
  summary("Keyword", "merge", 3, {}, callback(2, [0, 1], `${ELIXIR_DOCS}/Keyword.html#merge/3`)),
  summary("Keyword", "new", 1, {}, implicitCallback([0], `${ELIXIR_DOCS}/Enumerable.html`)),
  summary("Keyword", "new", 2, {}, callback(1, [0], `${ELIXIR_DOCS}/Keyword.html#new/2`)),

  summary("MapSet", "member?", 2, { 0: consume, 1: consume }),
  summary("MapSet", "put", 2, { 0: propagate, 1: propagate }),
  summary("MapSet", "delete", 2, { 0: propagate, 1: consume }),
  summary("MapSet", "new", 1, {}, implicitCallback([0], `${ELIXIR_DOCS}/Enumerable.html`)),
  summary("MapSet", "new", 2, {}, callback(1, [0], `${ELIXIR_DOCS}/MapSet.html#new/2`)),

  summary("Atom", "to_string", 1, { 0: consume }),
  summary("Kernel", "elem", 2, { 0: propagate, 1: consume }),
  summary("Enum", "map", 2, {}, callback(1, [0], `${ELIXIR_DOCS}/Enum.html#map/2`)),
  summary(
    "Enum",
    "flat_map",
    2,
    {},
    callback(1, [0], `${ELIXIR_DOCS}/Enum.html#flat_map/2`, "escape"),
  ),
  summary(
    "Enum",
    "reduce",
    3,
    {},
    callback(2, [0, 1], `${ELIXIR_DOCS}/Enum.html#reduce/3`, "escape"),
  ),
  summary("Enum", "member?", 2, {}, implicitCallback([0, 1], `${ELIXIR_DOCS}/Enum.html#member?/2`)),
  summary("Enum", "into", 2, {}, implicitCallback([0, 1], `${ELIXIR_DOCS}/Enum.html#into/2`)),
  summary(
    "Enum",
    "into",
    3,
    {},
    {
      ...callback(2, [0], `${ELIXIR_DOCS}/Enum.html#into/3`, "escape"),
      implicitCallbackAudit: {
        inputArguments: [1],
        documentation: `${ELIXIR_DOCS}/Collectable.html`,
      },
    },
  ),
] as const;

export function validateElixirAtomRoleSummaries(summaries: readonly ElixirAtomRoleSummary[]): void {
  const keys = new Set<string>();
  for (const entry of summaries) {
    const key = `${entry.module}\0${entry.name}\0${entry.arity}`;
    if (keys.has(key)) throw new Error(`duplicate Elixir atom role summary: ${key}`);
    keys.add(key);
    if (!Number.isInteger(entry.arity) || entry.arity < 0) {
      throw new Error(`invalid Elixir atom role arity ${entry.arity} for ${key}`);
    }
    for (const index of Object.keys(entry.arguments).map(Number)) {
      if (!Number.isInteger(index) || index < 0 || index >= entry.arity) {
        throw new Error(`invalid Elixir atom role argument ${index} for ${key}`);
      }
    }
    const callbackResultIndexes = Object.keys(entry.callbackResults ?? {})
      .map(Number)
      .sort((left, right) => left - right);
    const callbackAuditIndexes = Object.keys(entry.callbackAudits ?? {})
      .map(Number)
      .sort((left, right) => left - right);
    for (const index of callbackAuditIndexes) {
      if (!Number.isInteger(index) || index < 0 || index >= entry.arity) {
        throw new Error(`invalid Elixir atom callback audit ${index} for ${key}`);
      }
      if (entry.arguments[index] !== undefined) {
        throw new Error(`callback argument ${index} also has a value role for ${key}`);
      }
      const audit = entry.callbackAudits?.[index];
      if (audit === undefined) throw new Error(`missing callback audit ${index} for ${key}`);
      if (audit.resultRole !== "propagate-to-result" && audit.resultRole !== "escape") {
        throw new Error(`invalid callback result role for ${key}`);
      }
      const hasPropagatingResult = callbackResultIndexes.includes(index);
      if (hasPropagatingResult !== (audit.resultRole === "propagate-to-result")) {
        throw new Error(`callback result/audit mismatch for ${key}`);
      }
      validateCallbackAudit(entry, key, audit, index);
    }
    for (const index of callbackResultIndexes) {
      if (!callbackAuditIndexes.includes(index)) {
        throw new Error(`callback result/audit mismatch for ${key}`);
      }
    }
    if (entry.implicitCallbackAudit !== undefined)
      validateCallbackAudit(entry, key, entry.implicitCallbackAudit);
  }
}

function validateCallbackAudit(
  entry: ElixirAtomRoleSummary,
  key: string,
  audit: NonNullable<ElixirAtomRoleSummary["implicitCallbackAudit"]>,
  callbackArgument?: number,
): void {
  if (!audit.documentation.startsWith("https://")) {
    throw new Error(`invalid callback documentation for ${key}`);
  }
  const inputs = new Set(audit.inputArguments);
  if (inputs.size !== audit.inputArguments.length) {
    throw new Error(`duplicate callback input for ${key}`);
  }
  for (const input of inputs) {
    if (
      !Number.isInteger(input) ||
      input < 0 ||
      input >= entry.arity ||
      input === callbackArgument
    ) {
      throw new Error(`invalid callback input ${input} for ${key}`);
    }
    if (entry.arguments[input] !== undefined) {
      throw new Error(`callback-fed input ${input} has an optimistic role for ${key}`);
    }
  }
}

validateElixirAtomRoleSummaries(ELIXIR_ATOM_ROLE_SUMMARIES);

export type ElixirAtomRoleSummaryLookup = (
  module: string,
  name: string,
  arity: number,
) => ElixirAtomRoleSummary | undefined;

export function createElixirAtomRoleSummaryLookup(
  additional: readonly ElixirAtomRoleSummary[] = [],
): ElixirAtomRoleSummaryLookup {
  const summaries = [...ELIXIR_ATOM_ROLE_SUMMARIES, ...additional];
  validateElixirAtomRoleSummaries(summaries);
  const byCallee = new Map<string, ElixirAtomRoleSummary>();
  for (const entry of summaries) {
    byCallee.set(`${entry.module}\0${entry.name}\0${entry.arity}`, entry);
  }
  return (module, name, arity) => byCallee.get(`${module}\0${name}\0${arity}`);
}

const lookupCoreSummary = createElixirAtomRoleSummaryLookup();

export function lookupElixirAtomRoleSummary(
  module: string,
  name: string,
  arity: number,
): ElixirAtomRoleSummary | undefined {
  return lookupCoreSummary(module, name, arity);
}
