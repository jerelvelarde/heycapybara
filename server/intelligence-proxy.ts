import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { safeAgentError } from "./codex-agent";
import { READ_GRANT } from "./memory";

/**
 * The Intelligence MCP tool that reads the knowledge base Intelligence writes
 * from threads and user actions (the `/project` notes). @copilotkit/react-core
 * 1.73.3 calls it "the Intelligence MCP server's canonical tool name".
 */
export const KNOWLEDGE_TOOLS = ["copilotkit_knowledge_base_shell"] as const;

/**
 * Lets Codex use Intelligence's knowledge-base tool while the project key
 * stays in this process. CopilotKit's own route to the tool
 * (attachIntelligenceEnterpriseLearning and @ag-ui/mcp-middleware) only
 * serves agents that consume AG-UI tools, which the Codex agent does not.
 * The proxy connects to `${apiUrl}/mcp` with the headers CopilotKit sends
 * there (handlers/shared/agent-utils.mjs): the project key, the user, and a
 * read-only memory grant. It passes KNOWLEDGE_TOOLS through unchanged, with
 * Intelligence's own schema and results, and nothing else. Each upstream
 * call gives up after `timeoutMs` (30 seconds by default), and at once when
 * the incoming request is aborted.
 */
export function createIntelligenceProxy(options: {
  url: string;
  apiKey: string;
  userId: string;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}) {
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    "x-cpki-user-id": options.userId,
    "x-cpki-memory-grant": JSON.stringify(READ_GRANT),
  };
  const timeoutMs = options.timeoutMs ?? 30000;
  const allowed = new Set<string>(KNOWLEDGE_TOOLS);
  async function upstream<T>(
    incoming: AbortSignal,
    work: (client: Client, request: { signal: AbortSignal }) => Promise<T>,
  ) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([incoming, timeout]);
    const client = new Client({
      name: "openmuse-intelligence-proxy",
      version: "0.1.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    try {
      // Closing the client in `finally` also aborts the transport's own
      // in-flight fetch.
      await client.connect(transport, { signal });
      return await work(client, { signal });
    } catch (error) {
      const reason = timeout.aborted
        ? `Intelligence did not answer within ${timeoutMs / 1000} seconds.`
        : incoming.aborted
          ? "the request was cancelled."
          : safeAgentError(error);
      throw new Error("Intelligence knowledge base is unavailable: " + reason, {
        cause: error,
      });
    } finally {
      await client
        .close()
        .catch((error: unknown) =>
          console.error(
            "Could not close the Intelligence MCP connection:",
            error instanceof Error ? error.message : error,
          ),
        );
    }
  }
  return async (request: Request) => {
    // Each request is answered on its own; there is no event stream to offer.
    if (request.method === "GET")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const server = new Server(
      { name: "intelligence", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const { tools } = await upstream(request.signal, (client, options) =>
        client.listTools(undefined, options),
      );
      return { tools: tools.filter((tool) => allowed.has(tool.name)) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      if (!allowed.has(call.params.name))
        throw new Error(
          `The Intelligence tool ${call.params.name} is not available to OpenMuse.`,
        );
      return (await upstream(request.signal, (client, options) =>
        client.callTool(
          { name: call.params.name, arguments: call.params.arguments },
          undefined,
          options,
        ),
      )) as CallToolResult;
    });
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
