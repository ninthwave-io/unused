// Uses @fx/lib (a workspace: dep → kept alive via the sibling reference) but
// never imports @fx/unused-sib (a workspace: dep with zero imports → claimed).
import { libThing } from "@fx/lib";

export const app = (): number => libThing();
