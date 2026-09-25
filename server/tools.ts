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
import type { DesktopAction } from "../src/types";
import { safeAgentError } from "./codex-agent";
import { pointLabelSchema, screenshotIdSchema } from "./point-schema";

export function createToolHandler(options: {
  store: Store;
  intelligence?: CopilotKitIntelligence;
  containerId: string;
  action?: (action: DesktopAction, signal: AbortSignal) => Promise<void>;
}) {
  const registry = options.intelligence
    ? new SkillRegistry({
        client: options.intelligence,
        containerId: options.containerId,
        requestTimeoutMs: 15000,
      })
    : undefined;
  return async (request: Request) => {
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
          "Open an installed macOS app after a native user approval dialog",
        inputSchema: {
          bundleId: z
            .string()
            .max(255)
            .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
        },
      },
      async ({ bundleId }) => {
        if (!options.action) throw new Error("Desktop actions unavailable");
        await options.action({ type: "open-app", bundleId }, request.signal);
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
        );
        return result("Pointer displayed after user approval");
      },
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
