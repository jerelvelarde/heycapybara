import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { CodexRunner, KiteCodexAgent } from "./codex-agent";
import { createToolHandler, type DesktopActionHandler } from "./tools";
import type { Store } from "../electron/store";
import type { ScreenshotLookup } from "./screenshots";
import { runtimeConfig } from "./config";
import { authorized } from "./auth";
import { RunRegistry } from "./run-registry";
import { SkillRegistry } from "@copilotkit/runtime/internal/learned-skills";
import { createLearningReader, settleAfter } from "./learning";
import { createMemoryAccess } from "./memory";
import { KNOWLEDGE_TOOLS, createIntelligenceProxy } from "./intelligence-proxy";

export async function startRuntime(
  store: Store,
  options: {
    statePath?: string;
    binaryPath?: string;
    action?: DesktopActionHandler;
    // Required: see CodexRunnerOptions in server/codex-agent.ts for why a
    // real registry must always be supplied here.
    screenshots: ScreenshotLookup;
    // Called after every agent run ends, however it ended, with its thread id.
    onRunSettled?: (threadId: string) => void;
  },
) {
  const config = runtimeConfig(process.env);
  const token = randomBytes(32).toString("hex");
  // Generated once per install and persisted in the store (electron/store.ts
  // installUserId), so every run, memory and knowledge-base call in this
  // install shares one Intelligence user id without colliding with anyone
  // else who has the same project key.
  const localUser = { id: store.installUserId, name: "Kite desktop user" };
  const intelligence = config.intelligenceConfigured
    ? new CopilotKitIntelligence({
        apiKey: process.env.CPK_INTELLIGENCE_API_KEY!,
        getLearningContainerId: ({ agentId }) =>
          agentId === "default" ? config.containerId : undefined,
      })
    : undefined;
  // One registry for the MCP tools, the Codex catalog and learning status,
  // so all three see the same snapshot (5 s freshness, then a conditional
  // GET; SkillRegistry in @copilotkit/runtime/internal/learned-skills).
  const registry = intelligence
    ? new SkillRegistry({
        client: intelligence,
        containerId: config.containerId,
        requestTimeoutMs: 15000,
      })
    : undefined;
  const deliveredSkills = registry
    ? async () =>
        (await registry.acquireSnapshot()).skills.map(
          ({ name, description }) => ({ name, description }),
        )
    : undefined;
  const memory = intelligence
    ? createMemoryAccess(intelligence, localUser.id)
    : undefined;
  // ɵgetApiUrl is CopilotKit's own accessor for the endpoint its middleware
  // uses; recheck it on upgrade.
  const knowledge = intelligence
    ? createIntelligenceProxy({
        url: `${intelligence.ɵgetApiUrl()}/mcp`,
        apiKey: process.env.CPK_INTELLIGENCE_API_KEY!,
        userId: localUser.id,
      })
    : undefined;
  let sessionKey = process.env.OPENAI_API_KEY;
  const statePath = options.statePath || join(store.root, "agent");
  await mkdir(statePath, { recursive: true, mode: 0o700 });
  let workspace = join(statePath, "workspace");
  try {
    const saved = JSON.parse(
      await readFile(join(statePath, "workspace.json"), "utf8"),
    );
    if (typeof saved.path !== "string")
      throw new Error("Invalid saved workspace");
    workspace = await realpath(saved.path);
    if (!(await stat(workspace)).isDirectory())
      throw new Error("Saved workspace is not a directory");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    await mkdir(workspace, { recursive: true, mode: 0o700 });
  }
  let mcpUrl = "";
  const runs = new RunRegistry();
  const runner = new CodexRunner({
    statePath,
    binaryPath: options.binaryPath,
    screenshots: options.screenshots,
    runs,
    learnedSkills: deliveredSkills,
    recallMemories: memory
      ? (query, signal) => memory.recall(query, signal)
      : undefined,
    getConfig: () => ({
      apiKey: sessionKey,
      model: config.model,
      workspace,
      mcpUrl,
      intelligenceMcp:
        knowledge && mcpUrl
          ? { url: `${mcpUrl}/intelligence`, tools: KNOWLEDGE_TOOLS }
          : undefined,
    }),
  });
  const agent = new KiteCodexAgent(
    settleAfter(
      (input, signal) => runner.run(input, signal),
      (threadId) => options.onRunSettled?.(threadId),
    ),
  );
  const toolHandler = createToolHandler({
    store,
    intelligence,
    registry,
    containerId: config.containerId,
    action: options.action,
  });
  const runtime = intelligence
    ? new CopilotRuntime({
        agents: () => ({ default: agent }),
        intelligence,
        identifyUser: async () => localUser,
      })
    : new CopilotRuntime({ agents: () => ({ default: agent }) });
  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: "/api/copilotkit",
    mode: "single-route",
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/mcp/intelligence") {
        // The same live-run tokens as /mcp, so the project key never leaves
        // this process (server/intelligence-proxy.ts).
        if (!runs.authorize(request))
          return new Response("Unauthorized", { status: 401 });
        if (!knowledge)
          return new Response("Intelligence is not configured", {
            status: 404,
          });
        return knowledge(request);
      }
      if (pathname === "/mcp") {
        // Only a token held by a run that is still going passes
        // (server/run-registry.ts).
        const run = runs.authorize(request);
        if (!run) return new Response("Unauthorized", { status: 401 });
        return toolHandler(request, run);
      }
      const origin = request.headers.get("origin");
      const cors = {
        "Access-Control-Allow-Origin":
          origin === "http://127.0.0.1:5173" ? origin : "null",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        Vary: "Origin",
      };
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors });
      if (!authorized(request, token))
        return new Response("Unauthorized", { status: 401, headers: cors });
      try {
        const response = await handler(request);
        for (const [key, value] of Object.entries(cors))
          response.headers.set(key, value);
        return response;
      } catch {
        return new Response(
          JSON.stringify({
            error:
              "Runtime request failed. Check model credentials and Intelligence configuration.",
          }),
          {
            status: 502,
            headers: { ...cors, "Content-Type": "application/json" },
          },
        );
      }
    },
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) resolve();
    else {
      server.once("listening", resolve);
      server.once("error", reject);
    }
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Runtime failed to bind");
  mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
  const settings = {
    backend: "Codex SDK",
    // main.ts overwrites companion and onboardingComplete from preferences before any window reads them.
    companion: "capybara" as const,
    onboardingComplete: false,
    workspace,
    ...config,
    deliveryStatus: config.intelligenceConfigured
      ? "Not checked"
      : "Not configured",
    shortcut: "⌘ ⇧ K",
    runtimeUrl: `http://127.0.0.1:${address.port}/api/copilotkit`,
    runtimeToken: token,
  };

  return {
    server,
    close: () => {
      runner.stop();
      server.close();
    },
    setWorkspace: async (path: string) => {
      if (runner.busy)
        throw new Error("Stop the agent before changing workspace");
      const resolved = await realpath(path);
      if (!(await stat(resolved)).isDirectory())
        throw new Error("Select a workspace directory");
      await writeFile(
        join(statePath, "workspace.json"),
        JSON.stringify({ path: resolved }),
        { mode: 0o600 },
      );
      workspace = resolved;
      settings.workspace = resolved;
    },
    checkIntelligence: async () => {
      if (!intelligence) return "Not configured";
      try {
        const snapshot = await intelligence.getLearnedSkillsSnapshot({
          containerId: config.containerId,
          signal: AbortSignal.timeout(15000),
        });
        return `Verified · revision ${snapshot.revision}`;
      } catch (error) {
        return error instanceof Error
          ? error.message
          : "Delivery verification failed";
      }
    },
    setModelKey: (key: unknown) => {
      if (typeof key !== "string" || !/^sk-[A-Za-z0-9_-]{20,500}$/.test(key))
        throw new Error("Enter a valid OpenAI API key.");
      if (runner.busy)
        throw new Error("Stop the agent before changing credentials");
      sessionKey = key;
      settings.modelConfigured = true;
    },
    settings,
    // Everything the Electron main process polls to show learning progress.
    // The container is passed explicitly: the runtime's own
    // inspector/learning route only forwards it for the deprecated
    // `ɵlearning` option, not for getLearningContainerId.
    learning: intelligence
      ? createLearningReader({
          containerId: config.containerId,
          inspect: () =>
            intelligence.getInspectorLearning({
              agentId: "default",
              runtimeContainerId: config.containerId,
            }),
          skills: deliveredSkills,
          memories: memory ? () => memory.list() : undefined,
        })
      : undefined,
    // For "Learn from this" (electron/main.ts saveLesson).
    memory,
  };
}
