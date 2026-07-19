// `shared-lib` is declared in the ROOT package.json (hoisted) and imported only
// here in a member — it must be kept alive (root deps hoist to all members).
// `truly-unused` (also root-declared) is imported by no unit and is claimed.
import { x } from "shared-lib";

export const app = (): unknown => x();
