// How scripts/dev.mjs starts Electron. On macOS it goes through
// native/bin/kite-launch, which spawns Electron as its own responsible
// process, so macOS attributes Accessibility to Electron.app in node_modules
// instead of to the terminal or tool that ran `npm run dev`. Without the
// launcher, Electron is spawned directly, with a note saying where the
// permission will go.
export function electronCommand({ platform, electron, launcher, exists }) {
  if (platform !== "darwin") return { command: electron, args: ["."] };
  if (exists(launcher)) return { command: launcher, args: [electron, "."] };
  return {
    command: electron,
    args: ["."],
    note: "native/bin/kite-launch is missing (run npm run build:native), so macOS gives Accessibility to the app that ran npm run dev instead of Electron.",
  };
}
