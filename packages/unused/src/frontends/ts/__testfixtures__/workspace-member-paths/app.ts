// Root-package production entrypoint (`main`). Reaches `rootWidget` through the
// ROOT tsconfig's own `@root/*` -> `./shared/*` alias. Root-owned files must
// keep resolving through the root resolver/tsconfig — the per-member resolvers
// (T4.6) apply only to files under a workspace member, never to root files. The
// member's `@/*` alias is deliberately NOT defined at the root, so this file
// cannot see it.
import { rootWidget } from "@root/root-widget";

export function boot(): string {
  return rootWidget();
}
