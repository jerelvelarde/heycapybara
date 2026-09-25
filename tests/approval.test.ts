import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askApproval,
  approvalHost,
  type ApprovalDeps,
  type ApprovalDialogOptions,
  type SheetHost,
} from "../electron/approval";

const CANCELLED = "The request was cancelled before you answered.";
const CLOSED =
  "The approval prompt closed before you answered. Ask again if you still want this.";

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

// Only "Allow once" (1) approves. Electron turns a sheet ended from code
// (-1000, -1001) into the cancel button before it resolves, but every
// response other than 1 must decline however it arrives, so a check for
// "not Cancel" instead of "Allow once" fails here.
for (const response of [0, -1000, -1001, 2]) {
  test(`a response of ${response} resolves false`, async () => {
    const deps: ApprovalDeps = {
      activate: () => {},
      showMessageBox: async () => ({ response }),
      hostHidden: () => false,
    };
    assert.equal(
      await askApproval({ message: "Open application com.example.app" }, deps),
      false,
    );
  });
}

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

test("forwards the signal in the dialog options, so aborting it closes the box", async () => {
  const controller = new AbortController();
  let received: ApprovalDialogOptions | undefined;
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async (options) => {
      received = options;
      return { response: 1 };
    },
  };
  await askApproval(
    { message: "Open application com.example.app" },
    deps,
    controller.signal,
  );
  assert.equal(received?.signal, controller.signal);
});

test("a request cancelled before asking rejects without activating OpenMuse or showing the box", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  controller.abort();
  const deps: ApprovalDeps = {
    activate: () => {
      events.push("activate");
    },
    showMessageBox: async () => {
      events.push("showMessageBox");
      return { response: 1 };
    },
  };
  await assert.rejects(
    askApproval(
      { message: "Open application com.example.app" },
      deps,
      controller.signal,
    ),
    { message: CANCELLED },
  );
  assert.deepEqual(events, []);
});

// An aborted signal closes the box as if Cancel were pressed, so without
// this check the agent would be told the user declined.
test("a request cancelled while the box is open rejects instead of declining", async () => {
  const controller = new AbortController();
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => {
      controller.abort();
      return { response: 0 };
    },
    hostHidden: () => false,
  };
  await assert.rejects(
    askApproval(
      { message: "Open application com.example.app" },
      deps,
      controller.signal,
    ),
    { message: CANCELLED },
  );
});

// Hiding the host window ends its sheet as if Cancel were pressed. The host
// is on screen when the box opens and only goes away while it's open, so
// hostHidden has to be read after the box resolves.
test("a host hidden while the box is open rejects instead of declining", async () => {
  let hidden = false;
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => {
      hidden = true;
      return { response: 0 };
    },
    hostHidden: () => hidden,
  };
  await assert.rejects(
    askApproval({ message: "Open application com.example.app" }, deps),
    { message: CLOSED },
  );
});

test("a cancelled request is reported as cancelled even when the host hid too", async () => {
  const controller = new AbortController();
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => {
      controller.abort();
      return { response: 0 };
    },
    hostHidden: () => true,
  };
  await assert.rejects(
    askApproval(
      { message: "Open application com.example.app" },
      deps,
      controller.signal,
    ),
    { message: CANCELLED },
  );
});

// The user did answer. Callers check the signal again before acting, so a
// request cancelled at the same moment still doesn't run.
test("Allow once approves even when the request is cancelled and the host hides as the box resolves", async () => {
  const controller = new AbortController();
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => {
      controller.abort();
      return { response: 1 };
    },
    hostHidden: () => true,
  };
  assert.equal(
    await askApproval(
      { message: "Open application com.example.app" },
      deps,
      controller.signal,
    ),
    true,
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
    const result = approvalHost({ companionChat: chat, workspace });
    assert.equal(result.host, host === "chat" ? chat : workspace);
    assert.equal(result.mustShow, mustShow);
  });
}

// Only quitting destroys the workspace; closing it just hides it.
for (const { name, chat } of [
  { name: "chat hidden", chat: makeSheetHost(false) },
  { name: "chat destroyed", chat: makeSheetHost(false, true) },
]) {
  test(`approvalHost: ${name}, workspace destroyed: throws`, () => {
    assert.throws(
      () =>
        approvalHost({
          companionChat: chat,
          workspace: makeSheetHost(false, true),
        }),
      { message: "OpenMuse is closing." },
    );
  });
}
