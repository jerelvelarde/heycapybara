import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askApproval,
  type ApprovalDeps,
  type ApprovalDialogOptions,
} from "../electron/approval";

test("activate runs before showMessageBox", async () => {
  const events: string[] = [];
  const deps: ApprovalDeps = {
    activate: () => {
      events.push("activate");
    },
    showMessageBox: async () => {
      events.push("showMessageBox");
      return { response: 1 };
    },
  };
  await askApproval({ message: "Open application com.example.app" }, deps);
  assert.deepEqual(events, ["activate", "showMessageBox"]);
});

test("passes the exact dialog options for a prompt with a detail", async () => {
  let received: ApprovalDialogOptions | undefined;
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async (options) => {
      received = options;
      return { response: 1 };
    },
  };
  await askApproval(
    {
      message: "Show a pointer on Display A",
      detail: "The agent says it points at: Save button",
    },
    deps,
  );
  assert.deepEqual(received, {
    type: "question",
    title: "OpenMuse wants to take an action",
    message: "Show a pointer on Display A",
    detail: "The agent says it points at: Save button",
    buttons: ["Cancel", "Allow once"],
    defaultId: 0,
    cancelId: 0,
  });
});

test("leaves detail undefined for a prompt without one", async () => {
  let received: ApprovalDialogOptions | undefined;
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async (options) => {
      received = options;
      return { response: 1 };
    },
  };
  await askApproval({ message: "Open application com.example.app" }, deps);
  assert.equal(received?.detail, undefined);
});

test("a response of 1 resolves true", async () => {
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => ({ response: 1 }),
  };
  assert.equal(
    await askApproval({ message: "Open application com.example.app" }, deps),
    true,
  );
});

test("a response of 0 resolves false", async () => {
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => ({ response: 0 }),
  };
  assert.equal(
    await askApproval({ message: "Open application com.example.app" }, deps),
    false,
  );
});

test("a rejected showMessageBox rejects askApproval with the same error", async () => {
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => {
      throw new Error("dialog failed");
    },
  };
  let caught: unknown;
  try {
    await askApproval({ message: "Open application com.example.app" }, deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "dialog failed");
});
