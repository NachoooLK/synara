// FILE: modMcpClient.test.ts
// Purpose: Runs `$.mcp` against real MCP servers: a stdio server Synara starts
//          and stops, and a streamable HTTP server, both minimal fakes.
// Layer: Mods runtime tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandModMcpValue, ModMcpClient } from "./modMcpClient.ts";
import { ModManager } from "./modManager.ts";

// A stdio MCP server: answers initialize, lists one tool and echoes calls as JSON text.
const FAKE_STDIO_SERVER = `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdout.write("starting fake server (not JSON)\\n");
if (process.env.FAKE_PID_FILE) require("node:fs").writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (message.method === "tools/list") send({ id: message.id, result: { tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object" } }] } });
  else if (message.method === "tools/call") {
    if (message.params.name === "fail") send({ id: message.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
    else send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ echoed: message.params.arguments, token: process.env.FAKE_TOKEN }) }] } });
  }
});
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let root: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "synara-mod-mcp-test-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  rmSync(root, { recursive: true, force: true });
});

async function writeFakeStdioServer(): Promise<string> {
  const script = path.join(root, "fake-mcp.cjs");
  await writeFile(script, FAKE_STDIO_SERVER);
  return script;
}

describe("expandModMcpValue", () => {
  it("fills ${env:NAME} from the environment and leaves other text alone", () => {
    expect(expandModMcpValue("Bearer ${env:TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
    expect(expandModMcpValue("${env:MISSING}-x", {})).toBe("-x");
    expect(expandModMcpValue("$HOME ${other}", {})).toBe("$HOME ${other}");
  });
});

describe("ModMcpClient", () => {
  it("talks to a stdio server and passes environment variables through", async () => {
    process.env.SYNARA_TEST_FAKE_TOKEN = "secret-1";
    cleanups.push(() => {
      delete process.env.SYNARA_TEST_FAKE_TOKEN;
    });
    const client = new ModMcpClient("fake", {
      command: process.execPath,
      args: [await writeFakeStdioServer()],
      env: { FAKE_TOKEN: "${env:SYNARA_TEST_FAKE_TOKEN}" },
    });
    cleanups.push(() => client.close());
    await expect(client.listTools()).resolves.toEqual([
      { name: "echo", description: "Echoes", inputSchema: { type: "object" } },
    ]);
    const result = await client.callTool("echo", { pr: 7 });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      echoed: { pr: 7 },
      token: "secret-1",
    });
  });

  it("talks to a streamable HTTP server and keeps its session id", async () => {
    const sessions: Array<string | undefined> = [];
    const server: Server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        sessions.push(request.headers["mcp-session-id"] as string | undefined);
        const message = JSON.parse(body);
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "http", version: "1" },
              }
            : {
                content: [{ type: "text", text: "{}" }],
                structuredContent: { ok: true, auth: request.headers.authorization },
              };
        // Answer as an event stream, the way many streamable HTTP servers do.
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "session-9",
        });
        response.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    const client = new ModMcpClient("http", {
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { authorization: "Bearer fixed" },
    });
    cleanups.push(() => client.close());
    const result = await client.callTool("anything", {});
    expect(result.structuredContent).toEqual({ ok: true, auth: "Bearer fixed" });
    expect(sessions).toEqual([undefined, "session-9", "session-9"]);
  });
});

describe("$.mcp in a mod", () => {
  it("calls the servers the manifest declares and refuses others", async () => {
    const modsDir = path.join(root, "mods");
    const modRoot = path.join(modsDir, "mcp-user");
    await mkdir(path.join(modRoot, ".synara-mod"), { recursive: true });
    await mkdir(path.join(modRoot, "hooks"), { recursive: true });
    await writeFile(
      path.join(modRoot, ".synara-mod", "mod.json"),
      JSON.stringify({
        name: "mcp-user",
        version: "0.1.0",
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [await writeFakeStdioServer()],
            env: { FAKE_PID_FILE: path.join(root, "server.pid") },
          },
        },
      }),
    );
    await writeFile(
      path.join(modRoot, "hooks", "hooks.json"),
      JSON.stringify({ modules: ["./register.ts"] }),
    );
    await writeFile(
      path.join(modRoot, "hooks", "register.ts"),
      `
        export const register = (on) => {
          on("mod.start", async ($) => {
            await $.command.register({ name: "go", title: "Go" });
          });
          on("command.run", async ($) => {
            const tools = await $.mcp.tools("fake");
            const data = await $.mcp.json("fake", "echo", { n: 1 });
            const failure = await $.mcp.json("fake", "fail").catch((error) => error.message);
            const unknown = await $.mcp.call("other", "echo").catch((error) => error.message);
            return { text: JSON.stringify({ tools: tools.map((tool) => tool.name), data, failure, unknown }) };
          });
        };
      `,
    );
    const manager = new ModManager({
      modsDir,
      dataDir: path.join(root, "state"),
      watch: false,
      backend: { listThreads: async () => [], listProjects: async () => [], log: () => undefined },
    });
    cleanups.push(() => manager.stop());
    await manager.start();
    await manager.setEnabled("mcp-user", true);
    await manager.whenIdle();
    expect(manager.snapshot().mods[0]).toMatchObject({ status: "running", mcpServers: ["fake"] });

    const { text } = await manager.runCommand("mcp-user", "go", null);
    expect(JSON.parse(text ?? "null")).toEqual({
      tools: ["echo"],
      data: { echoed: { n: 1 } },
      failure: "it broke",
      unknown: '$.mcp: "other" is not one of this mod\'s MCP servers (fake).',
    });

    // Disabling the mod stops the server process it started.
    const pid = Number(await readFile(path.join(root, "server.pid"), "utf8"));
    expect(isAlive(pid)).toBe(true);
    await manager.setEnabled("mcp-user", false);
    const deadline = Date.now() + 5_000;
    while (isAlive(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(isAlive(pid)).toBe(false);
  });
});
