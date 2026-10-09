// FILE: modMcpClient.ts
// Purpose: The MCP client behind a mod's `$.mcp`: one connection per server the
//          mod's manifest declares, started on first use and closed with the mod.
//          Local servers speak JSON-RPC over stdio; remote ones streamable HTTP.
// Layer: Mods runtime

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ModMcpServerConfig } from "@synara/contracts";
import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";
import { spawnProcess } from "@synara/shared/processRuntime";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MCP_FRAME_BYTES = 8 * 1024 * 1024;
const MCP_STDERR_TAIL_CHARS = 2_000;
const CLIENT_INFO = { name: "synara-mods", version: "1" } as const;

export interface ModMcpTool {
  readonly name: string;
  readonly description: string | null;
  readonly inputSchema: unknown;
}

export interface ModMcpCallResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

export class ModMcpError extends Error {
  override readonly name = "ModMcpError";
}

/** Replaces `${env:NAME}` with Synara's environment variable (empty when unset). */
export function expandModMcpValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(
    /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu,
    (_, name: string) => env[name] ?? "",
  );
}

function expandRecord(
  record: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => [key, expandModMcpValue(value)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface McpTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly writer: JsonRpcStdioWriter;
  private readonly registry: JsonRpcStdioRequestRegistry;
  private readonly framer: JsonRpcStdioFramer;
  private stderrTail = "";
  private exitError: Error | null = null;

  constructor(
    serverName: string,
    config: Extract<ModMcpServerConfig, { readonly command: string }>,
  ) {
    this.child = spawnProcess(
      expandModMcpValue(config.command),
      (config.args ?? []).map((arg) => expandModMcpValue(arg)),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...expandRecord(config.env) },
        ...(config.cwd ? { cwd: expandModMcpValue(config.cwd) } : {}),
      },
    );
    this.writer = new JsonRpcStdioWriter(this.child.stdin);
    this.registry = new JsonRpcStdioRequestRegistry({
      requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS,
      includeJsonRpcVersion: true,
      timeoutError: (method) =>
        new ModMcpError(`The "${serverName}" MCP server did not answer ${method} within 30 s.`),
      responseError: ({ method, error }) =>
        new ModMcpError(
          `The "${serverName}" MCP server failed ${method}: ${error.message ?? "error"}`,
        ),
    });
    this.registry.processStarted();
    this.framer = new JsonRpcStdioFramer(MCP_FRAME_BYTES, () => undefined);
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const line of this.framer.push(chunk)) this.handleLine(line);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MCP_STDERR_TAIL_CHARS);
    });
    const fail = (reason: string) => {
      this.exitError ??= new ModMcpError(
        `The "${serverName}" MCP server ${reason}${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : "."}`,
      );
      this.registry.processExited(this.exitError);
    };
    this.child.on("error", (error) => fail(`could not start (${error.message})`));
    this.child.on("exit", (code, signal) =>
      fail(`exited (code ${code ?? "none"}, signal ${signal ?? "none"})`),
    );
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown> | null;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return; // Servers may log non-JSON lines to stdout; they are not protocol.
    }
    if (message === null) return;
    const id = message.id;
    if (typeof message.method === "string") {
      // A request from the server (ping, roots/list, sampling…): answer ping, refuse the rest.
      if (typeof id === "string" || typeof id === "number") {
        void this.writer
          .write(
            message.method === "ping"
              ? { jsonrpc: "2.0", id, result: {} }
              : {
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: "Not supported by Synara mods." },
                },
          )
          .catch(() => undefined);
      }
      return;
    }
    if (typeof id === "string" || typeof id === "number") {
      this.registry.handleResponse(message as never);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.exitError);
    return this.registry.request(method, params, (message) => this.writer.write(message));
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.exitError) throw this.exitError;
    await this.writer.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.registry.rejectAll(new ModMcpError("The mod's MCP connection closed."));
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}

class HttpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly serverName: string;
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly aborts = new Set<AbortController>();

  constructor(serverName: string, config: Extract<ModMcpServerConfig, { readonly url: string }>) {
    this.serverName = serverName;
    this.url = expandModMcpValue(config.url);
    if (!/^https?:\/\//iu.test(this.url)) {
      throw new ModMcpError(`The "${serverName}" MCP server URL must be http or https.`);
    }
    this.headers = expandRecord(config.headers);
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const abort = new AbortController();
    this.aborts.add(abort);
    const timer = setTimeout(() => abort.abort(), MCP_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(this.url, {
        method: "POST",
        headers: {
          ...this.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        signal: abort.signal,
      });
    } catch (error) {
      throw new ModMcpError(
        abort.signal.aborted
          ? `The "${this.serverName}" MCP server did not answer within 30 s.`
          : `The "${this.serverName}" MCP server cannot be reached: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
      this.aborts.delete(abort);
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ id, method, params });
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    if (!response.ok) {
      throw new ModMcpError(
        `The "${this.serverName}" MCP server answered ${method} with HTTP ${response.status}.`,
      );
    }
    const text = await response.text();
    const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
      : [text];
    for (const raw of messages) {
      let message: Record<string, unknown> | null = null;
      try {
        message = asRecord(JSON.parse(raw));
      } catch {
        continue;
      }
      if (message?.id !== id) continue;
      const error = asRecord(message.error);
      if (error) {
        throw new ModMcpError(
          `The "${this.serverName}" MCP server failed ${method}: ${String(error.message ?? "error")}`,
        );
      }
      return message.result;
    }
    throw new ModMcpError(`The "${this.serverName}" MCP server sent no answer to ${method}.`);
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.post({ method, params });
  }

  close(): void {
    for (const abort of this.aborts) abort.abort();
    this.aborts.clear();
  }
}

/** One MCP server of one mod. Connects on first use; `close()` ends it. */
export class ModMcpClient {
  private readonly serverName: string;
  private readonly config: ModMcpServerConfig;
  private connection: Promise<McpTransport> | null = null;
  private closed = false;

  constructor(serverName: string, config: ModMcpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  private connect(): Promise<McpTransport> {
    if (this.closed) return Promise.reject(new ModMcpError("The mod's MCP connection closed."));
    this.connection ??= (async () => {
      const transport: McpTransport =
        "command" in this.config
          ? new StdioTransport(this.serverName, this.config)
          : new HttpTransport(this.serverName, this.config);
      try {
        await transport.request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
        await transport.notify("notifications/initialized", {});
        return transport;
      } catch (error) {
        transport.close();
        throw error;
      }
    })();
    // A failed start can be retried by the next call.
    this.connection.catch(() => {
      this.connection = null;
    });
    return this.connection;
  }

  async listTools(): Promise<ModMcpTool[]> {
    const transport = await this.connect();
    const tools: ModMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = asRecord(await transport.request("tools/list", cursor ? { cursor } : {}));
      for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
        const record = asRecord(tool);
        if (typeof record?.name !== "string") continue;
        tools.push({
          name: record.name,
          description: typeof record.description === "string" ? record.description : null,
          inputSchema: record.inputSchema ?? null,
        });
      }
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(tool: string, args: unknown): Promise<ModMcpCallResult> {
    const transport = await this.connect();
    const result = asRecord(
      await transport.request("tools/call", { name: tool, arguments: asRecord(args) ?? {} }),
    );
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      structuredContent: result?.structuredContent ?? null,
      isError: result?.isError === true,
    };
  }

  close(): void {
    this.closed = true;
    void this.connection?.then(
      (transport) => transport.close(),
      () => undefined,
    );
    this.connection = null;
  }
}
