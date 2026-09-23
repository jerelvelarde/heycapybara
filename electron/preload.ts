import { contextBridge, ipcRenderer } from "electron";
import type { KiteAPI } from "../src/types";
const api: KiteAPI = {
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
  action: (action) => ipcRenderer.invoke("kite:action", action),
  openWorkspace: () => ipcRenderer.invoke("kite:openWorkspace"),
  openIntelligence: () => ipcRenderer.invoke("kite:openIntelligence"),
  onUpdate: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("kite:update", listener);
    return () => ipcRenderer.removeListener("kite:update", listener);
  },
};
contextBridge.exposeInMainWorld("kite", api);
