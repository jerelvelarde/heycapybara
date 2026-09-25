import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askApproval,
  approvalHost,
  type ApprovalDeps,
  type ApprovalDialogOptions,
  type SheetHost,
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
      message: "The agent wants to show a pointer on Display A",
      detail: "The agent says it points at: Save button",
    },
    deps,
  );
  assert.deepEqual(received, {
    type: "question",
    title: "OpenMuse wants to take an action",
    message: "The agent wants to show a pointer on Display A",
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
  assert.ok(received);
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
  const original = new Error("dialog failed");
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => {
      throw original;
    },
  };
  await assert.rejects(
    askApproval({ message: "Open application com.example.app" }, deps),
    (error: unknown) => error === original,
  );
});

function makeSheetHost(visible: boolean, destroyed = false): SheetHost {
  return {
    isVisible: () => {
      if (destroyed) throw new Error("Object has been destroyed");
      return visible;
    },
    isDestroyed: () => destroyed,
  };
}

const approvalHostCases: {
  name: string;
  chat: SheetHost;
  workspace: SheetHost;
  host: "chat" | "workspace";
  mustShow: boolean;
}[] = [
  {
    name: "chat visible: chat, no show",
    chat: makeSheetHost(true),
    workspace: makeSheetHost(false),
    host: "chat",
    mustShow: false,
  },
  {
    name: "chat hidden, workspace visible: workspace, no show",
    chat: makeSheetHost(false),
    workspace: makeSheetHost(true),
    host: "workspace",
    mustShow: false,
  },
  {
    name: "both hidden: workspace, must show",
    chat: makeSheetHost(false),
    workspace: makeSheetHost(false),
    host: "workspace",
    mustShow: true,
  },
  {
    name: "chat destroyed: workspace",
    chat: makeSheetHost(false, true),
    workspace: makeSheetHost(true),
    host: "workspace",
    mustShow: false,
  },
];

for (const { name, chat, workspace, host, mustShow } of approvalHostCases) {
  test(`approvalHost: ${name}`, () => {
    const result = approvalHost(chat, workspace);
    assert.equal(result.host, host === "chat" ? chat : workspace);
    assert.equal(result.mustShow, mustShow);
  });
}
