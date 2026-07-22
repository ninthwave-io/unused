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
  readonly origin:
    | { readonly pluginId: "language:elixir" }
    | { readonly pluginId: "convention:ecto"; readonly dependency: "ecto" };
}

export interface ElixirAtomRoleSummaryProvider {
  readonly id: "convention:ecto";
  readonly dependency: string;
  readonly summaries: readonly ElixirAtomRoleSummary[];
}

const core = { pluginId: "language:elixir" } as const;
const consume = "consume-data" as const;
const propagate = "propagate-to-result" as const;

export const defineElixirAtomRoleSummary = (
  module: string,
  name: string,
  arity: number,
  argumentRoles: Readonly<Record<number, ElixirAtomArgumentRole>>,
  options: {
    readonly callbackResults?: Readonly<Record<number, "propagate-to-result">>;
    readonly origin?: ElixirAtomRoleSummary["origin"];
  } = {},
): ElixirAtomRoleSummary => ({
  module,
  name,
  arity,
  arguments: argumentRoles,
  ...(options.callbackResults === undefined ? {} : { callbackResults: options.callbackResults }),
  origin: options.origin ?? core,
});
const summary = defineElixirAtomRoleSummary;

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
    { callbackResults: { 2: propagate } },
  ),
  summary(
    "Map",
    "put_new_lazy",
    3,
    { 0: propagate, 1: propagate },
    { callbackResults: { 2: propagate } },
  ),
  summary(
    "Map",
    "update",
    4,
    { 0: propagate, 1: propagate, 2: propagate },
    { callbackResults: { 3: propagate } },
  ),
  summary(
    "Map",
    "update!",
    3,
    { 0: propagate, 1: propagate },
    { callbackResults: { 2: propagate } },
  ),
  summary(
    "Map",
    "get_and_update",
    3,
    { 0: propagate, 1: propagate },
    { callbackResults: { 2: propagate } },
  ),
  summary("Map", "merge", 2, { 0: propagate, 1: propagate }),
  summary("Map", "merge", 3, { 0: propagate, 1: propagate }, { callbackResults: { 2: propagate } }),
  summary("Map", "new", 1, { 0: propagate }),
  summary("Map", "new", 2, { 0: consume }, { callbackResults: { 1: propagate } }),

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
    { callbackResults: { 2: propagate } },
  ),
  summary(
    "Keyword",
    "put_new_lazy",
    3,
    { 0: propagate, 1: propagate },
    { callbackResults: { 2: propagate } },
  ),
  summary(
    "Keyword",
    "update",
    4,
    { 0: propagate, 1: propagate, 2: propagate },
    { callbackResults: { 3: propagate } },
  ),
  summary(
    "Keyword",
    "update!",
    3,
    { 0: propagate, 1: propagate },
    { callbackResults: { 2: propagate } },
  ),
  summary("Keyword", "merge", 2, { 0: propagate, 1: propagate }),
  summary(
    "Keyword",
    "merge",
    3,
    { 0: propagate, 1: propagate },
    { callbackResults: { 2: propagate } },
  ),
  summary("Keyword", "new", 1, { 0: propagate }),
  summary("Keyword", "new", 2, { 0: consume }, { callbackResults: { 1: propagate } }),

  summary("MapSet", "member?", 2, { 0: consume, 1: consume }),
  summary("MapSet", "put", 2, { 0: propagate, 1: propagate }),
  summary("MapSet", "delete", 2, { 0: propagate, 1: consume }),
  summary("MapSet", "new", 1, { 0: propagate }),
  summary("MapSet", "new", 2, { 0: consume }, { callbackResults: { 1: propagate } }),

  summary("Atom", "to_string", 1, { 0: consume }),
  summary("Enum", "map", 2, { 0: consume }, { callbackResults: { 1: propagate } }),
  summary("Enum", "flat_map", 2, { 0: consume }, { callbackResults: { 1: propagate } }),
  summary("Enum", "reduce", 3, {}, { callbackResults: { 2: propagate } }),
  summary("Enum", "member?", 2, { 0: consume, 1: consume }),
  summary("Enum", "into", 2, { 0: propagate, 1: propagate }),
  summary("Enum", "into", 3, { 0: consume, 1: propagate }, { callbackResults: { 2: propagate } }),
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
    for (const index of Object.keys(entry.callbackResults ?? {}).map(Number)) {
      if (!Number.isInteger(index) || index < 0 || index >= entry.arity) {
        throw new Error(`invalid Elixir atom callback result ${index} for ${key}`);
      }
      if (entry.arguments[index] !== undefined) {
        throw new Error(`callback argument ${index} also has a value role for ${key}`);
      }
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
