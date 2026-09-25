import { contextBridge, ipcRenderer } from "electron";
import type { KiteAPI } from "../src/types";
// Electron prefixes main-process errors with the IPC channel; renderers show only the message.
const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    throw new Error(
      error instanceof Error
        ? error.message.replace(
            /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
            "",
          )
        : String(error),
    );
  });
const api: KiteAPI = {
  setCompanion: (companion) => invoke("kite:setCompanion", companion),
  completeOnboarding: (options) => invoke("kite:completeOnboarding", options),
  replayOnboarding: () => invoke("kite:replayOnboarding"),
  chooseWorkspace: () => invoke("kite:chooseWorkspace"),
  setModelKey: (key) => invoke("kite:setModelKey", key),
  verifyIntelligence: () => invoke("kite:verifyIntelligence"),
  reviewedRecording: (id) => invoke("kite:reviewedRecording", id),
  state: () => invoke("kite:state"),
  start: (title) => invoke("kite:start", title),
  stop: () => invoke("kite:stop"),
  note: (text) => invoke("kite:note", text),
  removeEvent: (r, e) => invoke("kite:removeEvent", r, e),
  deleteRecording: (id) => invoke("kite:deleteRecording", id),
  saveSkill: (input) => invoke("kite:saveSkill", input),
  deleteSkill: (id) => invoke("kite:deleteSkill", id),
  exportSkill: (id) => invoke("kite:exportSkill", id),
  permissions: (kind) => invoke("kite:permissions", kind),
  openPermissionSettings: (kind) => invoke("kite:openPermissionSettings", kind),
  screenshot: () => invoke("kite:screenshot"),
  buddyDrag: (action, point) => invoke("kite:buddyDrag", action, point),
  toggleCompanionChat: () => invoke("kite:toggleCompanionChat"),
  openCompanionTray: (mode) => invoke("kite:openCompanionTray", mode),
  closeCompanionChat: () => invoke("kite:closeCompanionChat"),
  openWorkspace: () => invoke("kite:openWorkspace"),
  openIntelligence: () => invoke("kite:openIntelligence"),
  onUpdate: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("kite:update", listener);
    return () => ipcRenderer.removeListener("kite:update", listener);
  },
};
contextBridge.exposeInMainWorld("kite", api);
