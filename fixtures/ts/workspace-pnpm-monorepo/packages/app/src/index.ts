// Consumes the sibling workspace package @fix/lib two ways: a bare specifier
// (resolves through its "." exports-map condition) AND a subpath specifier
// (resolves through its "./util" exports-map condition). Both must classify
// as an internal cross-workspace reference, never a phantom external
// dependency (assumption-set.md, "Monorepo workspaces are analyzed per
// package").
import { helper } from "@fix/lib";
import { util } from "@fix/lib/util";

export function run(): string {
  return `${helper()} ${util()}`;
}
