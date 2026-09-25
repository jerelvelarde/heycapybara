import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createIntelligenceProxy } from "../server/intelligence-proxy";

const KEY = "cpk-test-key-0000000000000000";
type Handler = (request: Request) => Promise<Response>;

// Stands in for Intelligence's /mcp endpoint: the knowledge-base tool the
// proxy may forward, and one it must never expose.
function fakeIntelligence() {
  const headers: Headers[] = [];
  const commands: string[] = [];
  async function handle(request: Request) {
    headers.push(request.headers);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const server = new McpServer({
      name: "fake-intelligence",
      version: "1.0.0",
    });
    server.registerTool(
      "copilotkit_knowledge_base_shell",
      {
        description: "Run a read command in the knowledge base",
        inputSchema: { command: z.string() },
      },
      async ({ command }) => {
        commands.push(command);
        return {
          content: [{ type: "text" as const, text: "/project/gmail-spam.md" }],
        };
      },
    );
    server.registerTool(
      "delete_project",
      { description: "Not for OpenMuse", inputSchema: {} },
      async () => {
        commands.push("delete");
        return { content: [{ type: "text" as const, text: "deleted" }] };
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      await server.close();
    }
  }
  return {
    headers,
    commands,
    fetch: (url: string | URL, init?: RequestInit) =>
      handle(new Request(url, init)),
  };
}

function proxyTo(
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>,
) {
  return createIntelligenceProxy({
    url: "https://intelligence.example.test/mcp",
    apiKey: KEY,
    userId: "kite-local-owner",
    fetch,
  });
}

// One JSON-RPC call to the proxy, as Codex sends it.
async function rpc(handler: Handler, method: string, params: unknown) {
  const response = await handler(
    new Request("http://127.0.0.1/mcp/intelligence", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(KEY), "the project key never reaches Codex");
  return JSON.parse(text);
}

test("the proxy lists only Intelligence's knowledge-base tool, with its own schema", async () => {
  const intelligence = fakeIntelligence();
  const listed = await rpc(proxyTo(intelligence.fetch), "tools/list", {});
  assert.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name),
    ["copilotkit_knowledge_base_shell"],
  );
  assert.ok(listed.result.tools[0].inputSchema.properties.command);
});

test("a knowledge-base call is forwarded with the project key, the user and a read-only grant", async () => {
  const intelligence = fakeIntelligence();
  const called = await rpc(proxyTo(intelligence.fetch), "tools/call", {
    name: "copilotkit_knowledge_base_shell",
    arguments: { command: "ls /project" },
  });
  assert.equal(called.result.content[0].text, "/project/gmail-spam.md");
  assert.deepEqual(intelligence.commands, ["ls /project"]);
  const sent = intelligence.headers[0];
  assert.equal(sent.get("authorization"), `Bearer ${KEY}`);
  assert.equal(sent.get("x-cpki-user-id"), "kite-local-owner");
  assert.deepEqual(JSON.parse(sent.get("x-cpki-memory-grant") ?? "null"), {
    user: "read",
    project: "read",
  });
});

test("any other Intelligence tool is refused without reaching Intelligence", async () => {
  const intelligence = fakeIntelligence();
  const refused = await rpc(proxyTo(intelligence.fetch), "tools/call", {
    name: "delete_project",
    arguments: {},
  });
  assert.match(
    refused.error.message,
    /The Intelligence tool delete_project is not available to OpenMuse\./,
  );
  assert.deepEqual(intelligence.commands, []);
});

test("an unreachable Intelligence is named as such and the key is redacted", async () => {
  const listed = await rpc(
    proxyTo(async () => {
      throw new Error(`request with Bearer ${KEY} failed`);
    }),
    "tools/list",
    {},
  );
  assert.match(
    listed.error.message,
    /^Intelligence knowledge base is unavailable: /,
  );
});

test("GET is refused, so Codex never waits on an event stream", async () => {
  const response = await proxyTo(fakeIntelligence().fetch)(
    new Request("http://127.0.0.1/mcp/intelligence", { method: "GET" }),
  );
  assert.equal(response.status, 405);
});
