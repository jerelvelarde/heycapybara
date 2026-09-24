export type CaptureEvent = {
  id: string;
  timestamp: string;
  kind: "app" | "click" | "shortcut" | "note" | "snapshot" | "error" | "status";
  app: string;
  bundleId: string;
  title: string;
  detail: string;
  x?: number;
  y?: number;
};
export type Recording = {
  id: string;
  title: string;
  startedAt: string;
  stoppedAt?: string;
  events: CaptureEvent[];
};
export type Skill = {
  id: string;
  name: string;
  markdown: string;
  recordingId: string;
  createdAt: string;
  approvedAt?: string;
};
export type Permissions = { accessibility: boolean; screenCapture: boolean };
export type Companion = "capybara" | "kite";
export type Settings = {
  companion: Companion;
  backend: string;
  workspace: string;
  containerId: string;
  model: string;
  shortcut: string;
  intelligenceConfigured: boolean;
  deliveryStatus: string;
  modelConfigured: boolean;
  runtimeUrl: string;
  runtimeToken: string;
};
export type Snapshot = {
  recordings: Recording[];
  skills: Skill[];
  active: Recording | null;
  permissions: Permissions;
  settings: Settings;
};
export type DesktopAction =
  | { type: "open-app"; bundleId: string }
  | { type: "point"; x: number; y: number };
export interface KiteAPI {
  state(): Promise<Snapshot>;
  setCompanion(companion: Companion): Promise<void>;
  setModelKey(key: string): Promise<void>;
  chooseWorkspace(): Promise<void>;
  verifyIntelligence(): Promise<void>;
  reviewedRecording(id: string): Promise<Recording>;
  start(title: string): Promise<Recording>;
  stop(): Promise<Recording>;
  note(text: string): Promise<void>;
  removeEvent(recordingId: string, eventId: string): Promise<void>;
  deleteRecording(id: string): Promise<void>;
  saveSkill(input: {
    id?: string;
    name: string;
    markdown: string;
    recordingId: string;
    approve: boolean;
  }): Promise<Skill>;
  deleteSkill(id: string): Promise<void>;
  exportSkill(id: string): Promise<boolean>;
  permissions(kind: "accessibility" | "screenCapture"): Promise<Permissions>;
  screenshot(): Promise<string>;
  action(action: DesktopAction): Promise<void>;
  buddyDrag(
    action: "begin" | "move" | "end",
    point: { x: number; y: number },
  ): Promise<void>;
  openWorkspace(): Promise<void>;
  openIntelligence(): Promise<void>;
  onUpdate(callback: () => void): () => void;
}
declare global {
  interface Window {
    kite?: KiteAPI;
  }
}
