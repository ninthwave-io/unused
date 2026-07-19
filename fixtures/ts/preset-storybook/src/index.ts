// The package's real entrypoint (package.json "main"). Its own export surface is
// alive; nothing here imports the story-only Widget or the Orphan component, so
// their liveness is decided solely by the storybook preset (Widget) or by
// nothing at all (Orphan).
export const libraryName = "widget-lib";
