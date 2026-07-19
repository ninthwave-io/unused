import { Capacitor } from "@capacitor/core";

// The production entrypoint (package.json "main"). It imports @capacitor/core, so
// that package is alive via a real reference edge — distinguishing it from the
// platform/CLI packages, which are kept alive only by the config-marker rule, and
// from @capacitor/camera (a plugin with a JS API), which is genuinely unused here.
export const platform = Capacitor.getPlatform();
