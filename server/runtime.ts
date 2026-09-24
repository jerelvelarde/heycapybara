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
import { createToolHandler } from "./tools";
import type { DesktopAction } from "../src/types";
import type { Store } from "../electron/store";
import { runtimeConfig } from "./config";
import { authorized } from "./auth";

export async function startRuntime(
  store: Store,
  options: {
    statePath?: string;
    binaryPath?: string;
    action?: (action: DesktopAction) => Promise<void>;
  } = {},
) {
  const config = runtimeConfig(process.env);
  const token = randomBytes(32).toString("hex");
  const intelligence = config.intelligenceConfigured
    ? new CopilotKitIntelligence({
        apiKey: process.env.CPK_INTELLIGENCE_API_KEY!,
        getLearningContainerId: ({ agentId }) =>
          agentId === "default" ? config.containerId : undefined,
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
  const mcpToken = randomBytes(32).toString("hex");
  const runner = new CodexRunner({
    statePath,
    binaryPath: options.binaryPath,
    getConfig: () => ({
      apiKey: sessionKey,
      model: config.model,
      workspace,
      mcpUrl,
      mcpToken,
    }),
  });
  const agent = new KiteCodexAgent((input, signal) =>
    runner.run(input, signal),
  );
  const toolHandler = createToolHandler({
    store,
    intelligence,
    containerId: config.containerId,
    action: options.action,
  });
  const runtime = intelligence
    ? new CopilotRuntime({
        agents: () => ({ default: agent }),
        intelligence,
        identifyUser: async () => ({
          id: "kite-local-owner",
          name: "Kite desktop user",
        }),
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
      if (new URL(request.url).pathname === "/mcp") {
        if (!authorized(request, mcpToken))
          return new Response("Unauthorized", { status: 401 });
        return toolHandler(request);
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
    companion: "capybara" as const,
    placement: "floating" as "notch" | "floating",
    onboardingComplete: true,
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
  };
}
