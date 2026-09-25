import { contextBridge, ipcRenderer } from "electron";
import type { KiteAPI } from "../src/types";
const api: KiteAPI = {
  setCompanion: (companion) =>
    ipcRenderer.invoke("kite:setCompanion", companion),
  setPlacement: (placement) =>
    ipcRenderer.invoke("kite:setPlacement", placement),
  completeOnboarding: () => ipcRenderer.invoke("kite:completeOnboarding"),
  replayOnboarding: () => ipcRenderer.invoke("kite:replayOnboarding"),
  startAppDrag: () => ipcRenderer.send("kite:startAppDrag"),
  openAccessibilitySettings: () =>
    ipcRenderer.invoke("kite:openAccessibilitySettings"),
  closeAccessibilityGuide: () =>
    ipcRenderer.invoke("kite:closeAccessibilityGuide"),
  revealAppInFinder: () => ipcRenderer.invoke("kite:revealAppInFinder"),
  setNotchExpanded: (expanded) =>
    ipcRenderer.invoke("kite:setNotchExpanded", expanded),
  chooseWorkspace: () => ipcRenderer.invoke("kite:chooseWorkspace"),
  setModelKey: (key) => ipcRenderer.invoke("kite:setModelKey", key),
  verifyIntelligence: () => ipcRenderer.invoke("kite:verifyIntelligence"),
  reviewedRecording: (id) => ipcRenderer.invoke("kite:reviewedRecording", id),
  state: () => ipcRenderer.invoke("kite:state"),
  start: (title) => ipcRenderer.invoke("kite:start", title),
  stop: () => ipcRenderer.invoke("kite:stop"),
  note: (text) => ipcRenderer.invoke("kite:note", text),
  removeEvent: (r, e) => ipcRenderer.invoke("kite:removeEvent", r, e),
  deleteRecording: (id) => ipcRenderer.invoke("kite:deleteRecording", id),
  saveSkill: (input) => ipcRenderer.invoke("kite:saveSkill", input),
  deleteSkill: (id) => ipcRenderer.invoke("kite:deleteSkill", id),
  exportSkill: (id) => ipcRenderer.invoke("kite:exportSkill", id),
  permissions: (kind) => ipcRenderer.invoke("kite:permissions", kind),
  screenshot: () => ipcRenderer.invoke("kite:screenshot"),
  buddyDrag: (action, point) =>
    ipcRenderer.invoke("kite:buddyDrag", action, point),
  toggleCompanionChat: () => ipcRenderer.invoke("kite:toggleCompanionChat"),
  openCompanionTray: (mode) =>
    ipcRenderer.invoke("kite:openCompanionTray", mode),
  closeCompanionChat: () => ipcRenderer.invoke("kite:closeCompanionChat"),
  openWorkspace: () => ipcRenderer.invoke("kite:openWorkspace"),
  openIntelligence: () => ipcRenderer.invoke("kite:openIntelligence"),
  onUpdate: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("kite:update", listener);
    return () => ipcRenderer.removeListener("kite:update", listener);
  },
};
contextBridge.exposeInMainWorld("kite", api);
