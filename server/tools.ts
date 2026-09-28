import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  SkillRegistry,
  formatSkillCatalog,
  loadSkill,
  readSkillFile,
} from "@copilotkit/runtime/internal/learned-skills";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { Store } from "../electron/store";
import type { DesktopAction, DesktopActionResult } from "../src/types";
import type { AgentRun } from "./run-registry";
import { safeAgentError } from "./codex-agent";
import {
  bundleIdSchema,
  pointLabelSchema,
  screenshotIdSchema,
} from "./point-schema";
import {
  BLOCKED_CHORD_MESSAGE,
  TYPE_MAX_LENGTH,
  blockedChord,
  clicksSchema,
  httpsUrlSchema,
  keyNameSchema,
  modifiersSchema,
  mouseButtonSchema,
  scrollAmountSchema,
  scrollDirectionSchema,
  typedTextSchema,
} from "./computer-schema";

// `signal` aborts when this one tool call is cancelled (Codex dropped its
// request); `run.signal` when the whole run ends. A control grant lasts for
// the run (electron/control-grant.ts).
export type DesktopActionHandler = (
  action: DesktopAction,
  signal: AbortSignal,
  run: AgentRun,
) => Promise<DesktopActionResult | void>;

export function createToolHandler(options: {
  store: Store;
  intelligence?: CopilotKitIntelligence;
  containerId: string;
  action?: DesktopActionHandler;
}) {
  const registry = options.intelligence
    ? new SkillRegistry({
        client: options.intelligence,
        containerId: options.containerId,
        requestTimeoutMs: 15000,
      })
    : undefined;
  return async (request: Request, run: AgentRun) => {
    const server = new McpServer({ name: "kite", version: "0.2.0" });
    const result = (text: string) => ({
      content: [{ type: "text" as const, text }],
    });
    server.registerTool(
      "list_local_skills",
      {
        description: "List user-approved local workflow skills",
        inputSchema: {},
      },
      async () =>
        result(
          JSON.stringify(
            options.store
              .approvedSkills()
              .map((s) => ({ id: s.id, name: s.name })),
          ),
        ),
    );
    server.registerTool(
      "load_local_skill",
      {
        description: "Load a user-approved local workflow skill",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const skill = options.store.approvedSkills().find((s) => s.id === id);
        if (!skill) throw new Error("Approved skill not found");
        return result(skill.markdown);
      },
    );
    server.registerTool(
      "list_learned_skills",
      {
        description:
          "Discover published CopilotKit Intelligence skills for this workflow container",
        inputSchema: {},
      },
      async () => {
        if (!registry) return result("Intelligence is not configured");
        return result(formatSkillCatalog(await registry.acquireSnapshot()));
      },
    );
    server.registerTool(
      "load_learned_skill",
      {
        description: "Load a published Intelligence skill by name",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        if (!registry) throw new Error("Intelligence is not configured");
        return result(loadSkill(await registry.acquireSnapshot(), name));
      },
    );
    server.registerTool(
      "read_learned_skill_file",
      {
        description:
          "Read a supporting text file from a published Intelligence skill",
        inputSchema: { name: z.string(), path: z.string() },
      },
      async ({ name, path }) => {
        if (!registry) throw new Error("Intelligence is not configured");
        return result(
          readSkillFile(await registry.acquireSnapshot(), name, path),
        );
      },
    );
    server.registerTool(
      "open_application",
      {
        description:
          "Open an installed macOS app after a native user approval dialog, unless the user already let you control the Mac for this task",
        inputSchema: {
          bundleId: bundleIdSchema,
        },
      },
      async ({ bundleId }) => {
        if (!options.action) throw new Error("Desktop actions unavailable");
        await options.action(
          { type: "open-app", bundleId },
          request.signal,
          run,
        );
        return result("Application opened after user approval");
      },
    );
    server.registerTool(
      "point_on_screen",
      {
        description:
          "Show a pointer on something visible in a screenshot the user attached, after native approval. Pass that screenshot's id and x, y in its pixels (origin at the top-left). Does not click.",
        inputSchema: {
          screenshotId: screenshotIdSchema,
          x: z.number(),
          y: z.number(),
          label: pointLabelSchema.describe(
            'What you are pointing at, such as "Export button". The user sees it in the approval dialog: one line of visible text, up to 60 characters, with at least one letter or number.',
          ),
        },
      },
      async ({ screenshotId, x, y, label }) => {
        if (!options.action) throw new Error("Desktop actions unavailable");
        await options.action(
          { type: "point", screenshotId, x, y, label },
          request.signal,
          run,
        );
        return result("Pointer displayed after user approval");
      },
    );
    // A computer-use tool's result: OpenMuse's note, then the screenshot it
    // describes, when the action took one.
    const act = async (action: DesktopAction) => {
      if (!options.action) throw new Error("Desktop actions unavailable");
      const outcome = await options.action(action, request.signal, run);
      if (!outcome) throw new Error("The desktop action returned no result");
      return {
        content: [
          { type: "text" as const, text: outcome.text },
          ...(outcome.screenshot
            ? [
                {
                  type: "image" as const,
                  data: outcome.screenshot.png,
                  mimeType: "image/png",
                },
              ]
            : []),
        ],
      };
    };
    const target = {
      screenshotId: screenshotIdSchema,
      x: z.number(),
      y: z.number(),
      label: pointLabelSchema.describe(
        'What you act on, such as "Report spam button": one line of visible text, up to 60 characters, with at least one letter or number. The first action in a task shows it to the user.',
      ),
    };
    server.registerTool(
      "take_screenshot",
      {
        description:
          "See the main display while you carry out a task on the user's Mac. The first computer-use tool you call in a task asks the user to let you control the Mac until the task ends. Returns the screenshot and its id; click_on_screen, scroll_on_screen and point_on_screen take x, y in its pixels.",
        inputSchema: {},
      },
      async () => act({ type: "screenshot" }),
    );
    server.registerTool(
      "click_on_screen",
      {
        description:
          "Click something visible in a screenshot. Pass the screenshot's id, x, y in its pixels (origin at the top-left) and a short label naming the target. A ring shows the spot just before the click. Returns a screenshot taken after the click; use it for your next click or scroll.",
        inputSchema: {
          ...target,
          button: mouseButtonSchema,
          clicks: clicksSchema.describe(
            "2 for a double click, 3 for a triple click",
          ),
        },
      },
      async ({ screenshotId, x, y, label, button, clicks }) =>
        act({ type: "click", screenshotId, x, y, label, button, clicks }),
    );
    server.registerTool(
      "scroll_on_screen",
      {
        description:
          "Scroll whatever is under a spot in a screenshot, by 1 to 10 wheel notches. Pass the screenshot's id, x, y in its pixels and a short label naming what you scroll. Returns a screenshot taken after the scroll.",
        inputSchema: {
          ...target,
          direction: scrollDirectionSchema,
          amount: scrollAmountSchema,
        },
      },
      async ({ screenshotId, x, y, label, direction, amount }) =>
        act({ type: "scroll", screenshotId, x, y, label, direction, amount }),
    );
    server.registerTool(
      "type_text",
      {
        description: `Type text into the focused field of the frontmost app, up to ${TYPE_MAX_LENGTH} characters. Click the field first. No line breaks or tabs: use press_keys for Return, Tab and other keys. Refused while OpenMuse itself is in front, and in password fields the app reports to Accessibility; never enter passwords, payment details or one-time codes regardless.`,
        inputSchema: { text: typedTextSchema },
      },
      async ({ text }) => act({ type: "type", text }),
    );
    server.registerTool(
      "press_keys",
      {
        description:
          'Press one key, optionally with modifier keys held, such as key "l" with modifiers ["command"] to focus a browser\'s address bar, or "return" alone. Key names are key positions on a US keyboard; use type_text to enter text. Refused while OpenMuse itself is in front, and character-key presses are refused in password fields the app reports to Accessibility; never enter passwords, payment details or one-time codes regardless.',
        inputSchema: { key: keyNameSchema, modifiers: modifiersSchema },
      },
      async ({ key, modifiers }) => {
        if (blockedChord(key, modifiers))
          throw new Error(BLOCKED_CHORD_MESSAGE);
        return act({ type: "keys", key, modifiers });
      },
    );
    server.registerTool(
      "open_url",
      {
        description:
          "Open an https web page in an installed app, such as Google Chrome (com.google.Chrome) or Safari (com.apple.Safari). Asks the user first, unless they already let you control the Mac for this task.",
        inputSchema: { url: httpsUrlSchema, bundleId: bundleIdSchema },
      },
      async ({ url, bundleId }) => act({ type: "open-url", url, bundleId }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // Buffer the JSON response before closing this stateless transport.
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return Response.json({ error: safeAgentError(error) }, { status: 500 });
    } finally {
      await server.close();
    }
  };
}
