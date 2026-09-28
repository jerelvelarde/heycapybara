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
export type PermissionKind = keyof Permissions;
export type Companion = "capybara" | "kite";
export type CompanionTrayMode = "chat" | "record";
export type Settings = {
  companion: Companion;
  onboardingComplete: boolean;
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
  trayMode: CompanionTrayMode;
};
export type ScreenshotAttachment = {
  id: string;
  label: string;
  // Pixel dimensions of the PNG in dataUrl, not points.
  width: number;
  height: number;
  dataUrl: string;
};
export type DesktopAction =
  | { type: "open-app"; bundleId: string }
  | {
      type: "point";
      screenshotId: string;
      // Pixels within that screenshot (origin top-left), not global screen
      // points. The main process resolves the pixel against the
      // screenshot's registered display and converts it to global screen
      // points before it reaches the native pointer helper.
      x: number;
      y: number;
      label: string;
    }
  | { type: "open-url"; url: string; bundleId: string }
  | { type: "screenshot" }
  | {
      type: "click";
      // Like "point": pixels in that screenshot, converted to screen
      // points in the main process.
      screenshotId: string;
      x: number;
      y: number;
      label: string;
      button: "left" | "right";
      clicks: number;
    }
  | {
      type: "scroll";
      screenshotId: string;
      x: number;
      y: number;
      label: string;
      direction: "up" | "down" | "left" | "right";
      amount: number;
    }
  | { type: "type"; text: string }
  | {
      type: "keys";
      key: string;
      modifiers: ("command" | "shift" | "option" | "control")[];
    };
// A screenshot a computer-use tool returns to the model. `png` is the
// image's bare base64, as an MCP image content block carries it.
export type ActionScreenshot = {
  id: string;
  label: string;
  width: number;
  height: number;
  png: string;
};
// What a desktop action tells the model: OpenMuse's note, and the
// screenshot it describes when the action took one.
export type DesktopActionResult = {
  text: string;
  screenshot?: ActionScreenshot;
};
export interface KiteAPI {
  state(): Promise<Snapshot>;
  setCompanion(companion: Companion): Promise<void>;
  completeOnboarding(options?: { openWorkspace?: boolean }): Promise<void>;
  replayOnboarding(): Promise<void>;
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
  permissions(kind: PermissionKind): Promise<Permissions>;
  openPermissionSettings(kind: PermissionKind): Promise<void>;
  screenshot(): Promise<ScreenshotAttachment>;
  buddyDrag(
    action: "begin" | "move" | "end",
    point: { x: number; y: number },
  ): Promise<void>;
  toggleCompanionChat(): Promise<void>;
  openCompanionTray(mode: CompanionTrayMode): Promise<void>;
  closeCompanionChat(): Promise<void>;
  openWorkspace(): Promise<void>;
  openIntelligence(): Promise<void>;
  onUpdate(callback: () => void): () => void;
}
declare global {
  interface Window {
    kite?: KiteAPI;
  }
}
