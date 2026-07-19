// This file is never imported by any entrypoint — it is a dead file (claimed).
// The dependency it imports (`dead-code-dep`) is still referenced by a source
// file, so it is kept alive: deleting it is a human cascade decision.
import { b } from "dead-code-dep";

export const orphan = (): unknown => b();
