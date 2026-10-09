// FILE: modMcpClient.test.ts
// Purpose: Runs `$.mcp` against real MCP servers: a stdio server Synara starts
//          and stops, and a streamable HTTP server, both minimal fakes. Covers the
//          filtered child environment, process-tree teardown, open event streams,
//          cancellation on close and session renewal.
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
// FAKE_SILENT_INIT never answers initialize; FAKE_GRANDCHILD_PID_FILE starts a
// grandchild the way `npx` starts the real server.
const FAKE_STDIO_SERVER = `
const readline = require("node:readline");
const fs = require("node:fs");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdout.write("starting fake server (not JSON)\\n");
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
if (process.env.FAKE_GRANDCHILD_PID_FILE) {
  const grandchild = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_GRANDCHILD_PID_FILE, String(grandchild.pid));
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (!process.env.FAKE_SILENT_INIT) send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  }
  else if (message.method === "tools/list") send({ id: message.id, result: { tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object" } }] } });
  else if (message.method === "tools/call") {
    if (message.params.name === "fail") send({ id: message.id, result: { content: [{ type: "text", text: "it broke" }], isError: true } });
    else send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ echoed: message.params.arguments, token: process.env.FAKE_TOKEN, refused: process.env.FAKE_REFUSED, leak: process.env.SYNARA_MOD_MCP_TEST_SECRET }) }] } });
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

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting in the test.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readPid(file: string): Promise<number | undefined> {
  return readFile(file, "utf8").then(
    (text) => (text ? Number(text) : undefined),
    () => undefined,
  );
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

function setEnv(name: string, value: string): void {
  process.env[name] = value;
  cleanups.push(() => {
    delete process.env[name];
  });
}

async function writeFakeStdioServer(): Promise<string> {
  const script = path.join(root, "fake-mcp.cjs");
  await writeFile(script, FAKE_STDIO_SERVER);
  return script;
}

interface FakeHttpRequest {
  readonly method: string;
  readonly tool: string | undefined;
  readonly session: string | undefined;
  readonly auth: string | undefined;
}

/**
 * A streamable HTTP MCP server answering over an event stream: a notification
 * first, then the answer split over two `data:` lines. Sessions start at
 * `initialize`; a request with an unknown session gets 404. The tool "hang"
 * never answers, and `keepOpen` leaves every stream open after the answer.
 */
async function startFakeHttpServer(options: { keepOpen?: boolean; status?: number } = {}) {
  const requests: FakeHttpRequest[] = [];
  const sessions = new Set<string>();
  let created = 0;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body);
      const session = request.headers["mcp-session-id"] as string | undefined;
      requests.push({
        method: message.method,
        tool: message.params?.name,
        session,
        auth: request.headers.authorization,
      });
      if (options.status !== undefined) {
        response.writeHead(options.status).end();
        return;
      }
      if (message.method !== "initialize" && (session === undefined || !sessions.has(session))) {
        response.writeHead(404).end();
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const headers: Record<string, string> = { "content-type": "text/event-stream" };
      if (message.method === "initialize") {
        headers["mcp-session-id"] = `session-${++created}`;
        sessions.add(headers["mcp-session-id"]);
      }
      response.writeHead(200, headers);
      response.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`,
      );
      if (message.params?.name === "hang") {
        response.write(": still working\n\n");
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
      const json = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      const cut = json.indexOf(",") + 1;
      response.write(`event: message\ndata: ${json.slice(0, cut)}\ndata: ${json.slice(cut)}\n\n`);
      if (!options.keepOpen) response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, requests, sessions };
}

describe("expandModMcpValue", () => {
  it("fills ${env:NAME} from the environment and leaves other text alone", () => {
    expect(expandModMcpValue("Bearer ${env:TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
    expect(expandModMcpValue("${env:MISSING}-x", {})).toBe("-x");
    expect(expandModMcpValue("$HOME ${other}", {})).toBe("$HOME ${other}");
  });

  it("never expands Synara's own variables", () => {
    const env = { SYNARA_AUTH_TOKEN: "secret", synara_auth_token: "secret" };
    expect(expandModMcpValue("Bearer ${env:SYNARA_AUTH_TOKEN}", env)).toBe("Bearer ");
    expect(expandModMcpValue("${env:synara_auth_token}", env)).toBe("");
  });
});

describe("ModMcpClient", () => {
  it("gives a stdio server only the explicit env, never Synara's own variables", async () => {
    setEnv("MOD_MCP_TEST_TOKEN", "secret-1");
    setEnv("SYNARA_MOD_MCP_TEST_SECRET", "leak");
    const client = new ModMcpClient("fake", {
      command: process.execPath,
      args: [await writeFakeStdioServer()],
      env: {
        FAKE_TOKEN: "${env:MOD_MCP_TEST_TOKEN}",
        FAKE_REFUSED: "${env:SYNARA_MOD_MCP_TEST_SECRET}",
      },
    });
    cleanups.push(() => client.close());
    await expect(client.listTools()).resolves.toEqual([
      { name: "echo", description: "Echoes", inputSchema: { type: "object" } },
    ]);
    const result = await client.callTool("echo", { pr: 7 });
    // No `leak`: the SYNARA_ variable is not inherited, and `${env:SYNARA_*}` is empty.
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      echoed: { pr: 7 },
      token: "secret-1",
      refused: "",
    });
  });

  it("stops a server still starting at once, grandchildren included", async () => {
    const pidFile = path.join(root, "server.pid");
    const grandchildPidFile = path.join(root, "grandchild.pid");
    const client = new ModMcpClient("slow", {
      command: process.execPath,
      args: [await writeFakeStdioServer()],
      env: {
        FAKE_SILENT_INIT: "1",
        FAKE_PID_FILE: pidFile,
        FAKE_GRANDCHILD_PID_FILE: grandchildPidFile,
      },
    });
    cleanups.push(() => client.close());
    const listing = client.listTools().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const pid = await waitFor(() => readPid(pidFile));
    const grandchild = await waitFor(() => readPid(grandchildPidFile));
    cleanups.push(() => {
      if (isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
    });
    expect(isAlive(grandchild)).toBe(true);

    const started = Date.now();
    await client.close();
    expect(await listing).toBe("The mod's MCP connection closed.");
    // Far below the 30 s initialize timeout the old close() waited for.
    expect(Date.now() - started).toBeLessThan(10_000);
    await waitFor(() => (isAlive(pid) || isAlive(grandchild) ? undefined : true));
  });

  it("talks to a streamable HTTP server and keeps its session id", async () => {
    const fake = await startFakeHttpServer();
    const client = new ModMcpClient("http", {
      url: fake.url,
      headers: { authorization: "Bearer fixed" },
    });
    cleanups.push(() => client.close());
    const result = await client.callTool("anything", {});
    expect(result.structuredContent).toEqual({ ok: true, auth: "Bearer fixed" });
    expect(fake.requests.map(({ method, session }) => [method, session])).toEqual([
      ["initialize", undefined],
      ["notifications/initialized", "session-1"],
      ["tools/call", "session-1"],
    ]);
  });

  it("answers from an event stream the server keeps open, and close() cancels a pending call", async () => {
    const fake = await startFakeHttpServer({ keepOpen: true });
    const client = new ModMcpClient("http", { url: fake.url });
    cleanups.push(() => client.close());
    await expect(client.callTool("anything", {})).resolves.toMatchObject({
      structuredContent: { ok: true },
    });

    const pending = client.callTool("hang", {}).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await waitFor(() => (fake.requests.some(({ tool }) => tool === "hang") ? true : undefined));
    await client.close();
    expect(await pending).toBe("The mod's MCP connection closed.");
  });

  it("starts a new session once when the server forgets the old one", async () => {
    const fake = await startFakeHttpServer();
    const client = new ModMcpClient("http", { url: fake.url });
    cleanups.push(() => client.close());
    await client.callTool("first", {});
    fake.sessions.clear(); // The server restarted.
    await expect(client.callTool("second", {})).resolves.toMatchObject({
      structuredContent: { ok: true },
    });
    expect(fake.requests.map(({ method, session }) => [method, session])).toEqual([
      ["initialize", undefined],
      ["notifications/initialized", "session-1"],
      ["tools/call", "session-1"],
      ["tools/call", "session-1"],
      ["initialize", undefined],
      ["notifications/initialized", "session-2"],
      ["tools/call", "session-2"],
    ]);
  });

  it("says which ${env:SYNARA_*} it left empty when the server refuses", async () => {
    setEnv("SYNARA_MOD_MCP_TEST_SECRET", "leak");
    const fake = await startFakeHttpServer({ status: 401 });
    const client = new ModMcpClient("http", {
      url: fake.url,
      headers: { authorization: "Bearer ${env:SYNARA_MOD_MCP_TEST_SECRET}" },
    });
    cleanups.push(() => client.close());
    await expect(client.listTools()).rejects.toThrow(
      'The "http" MCP server answered initialize with HTTP 401. (${env:SYNARA_MOD_MCP_TEST_SECRET} was left empty',
    );
    expect(fake.requests[0]?.auth?.trim()).toBe("Bearer");
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
