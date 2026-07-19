// A Capacitor app's config file at the workspace root — its mere presence
// activates the `capacitor-platform-dependency` keep-alive for the native
// platform + CLI packages. Deliberately imports nothing, so `@capacitor/cli` is
// kept alive by the config marker rule, not by an import edge.
const config = {
  appId: "com.example.app",
  appName: "app",
  webDir: "dist",
};

export default config;
