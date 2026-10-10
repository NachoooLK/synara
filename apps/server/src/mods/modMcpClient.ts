// FILE: modMcpClient.ts
// Purpose: The MCP client behind a mod's `$.mcp`: one connection per server the
//          mod's manifest declares, started on first use and closed with the mod.
//          Local servers speak JSON-RPC over stdio in their own process tree, with
//          the filtered environment provider children get; remote ones speak
//          streamable HTTP under one deadline per request, body included, and
//          carry the person's sign-in when the server asks for one.
// Layer: Mods runtime

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ModMcpServerConfig } from "@synara/contracts";
import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";
import { spawnProcess } from "@synara/shared/processRuntime";

import { teardownChildProcessTree } from "../platform/supervisedProcessTeardown.ts";
import {
  buildProviderChildEnvironment,
  withoutProviderCredentialEnvironment,
} from "../providerChildEnvironment.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = 30_000;
/** Caps one stdio line and one HTTP answer body. */
const MCP_FRAME_BYTES = 8 * 1024 * 1024;
const MCP_STDERR_TAIL_CHARS = 2_000;
const CLIENT_INFO = { name: "synara-mods", version: "1" } as const;
const INITIALIZE_PARAMS = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: CLIENT_INFO,
} as const;
const CLOSED_MESSAGE = "The mod's MCP connection closed.";
const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu;

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

/** The `code` of the error a mod's call fails with while its server waits for a sign-in. */
export const MOD_MCP_SIGN_IN_NEEDED_CODE = "mcp_sign_in_needed";

/** The call cannot be made until the person signs in to the server. */
export class ModMcpSignInNeededError extends ModMcpError {
  readonly code = MOD_MCP_SIGN_IN_NEEDED_CODE;
}

/** A request the server would not serve for lack of a sign-in it accepts. */
export interface ModMcpRefusal {
  readonly status: number;
  /** The `WWW-Authenticate` header, which may say where to sign in. */
  readonly challenge: string | null;
  /** The token the request carried, or null when it carried none. */
  readonly token: string | null;
}

/**
 * The person's sign-in to one remote server. It lives outside the client: the
 * token never enters the mod, and it outlasts the connection.
 */
export interface ModMcpAccess {
  /**
   * The token to send, or null for a server not known to ask for one. Throws
   * `ModMcpSignInNeededError` when the person has to sign in first.
   */
  readonly token: () => Promise<string | null>;
  /**
   * Resolves true when the request should be sent again (there is a new
   * token) and false when the refusal is not about signing in; throws
   * `ModMcpSignInNeededError` when the person has to sign in.
   */
  readonly refused: (refusal: ModMcpRefusal) => Promise<boolean>;
}

/** Synara's own variables (auth token, ports, homes) are never handed to a mod. */
function isSynaraVariable(name: string): boolean {
  // Uppercased because Windows environment names are case-insensitive.
  return name.toUpperCase().startsWith("SYNARA_");
}

/**
 * Replaces `${env:NAME}` with Synara's environment variable (empty when unset).
 * `SYNARA_*` names always expand to empty.
 */
export function expandModMcpValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_REFERENCE, (_, name: string) =>
    isSynaraVariable(name) ? "" : (env[name] ?? ""),
  );
}

function expandRecord(
  record: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => [key, expandModMcpValue(value)]),
  );
}

/** The `${env:SYNARA_*}` names a config asks for; they were left empty. */
function refusedEnvNames(config: ModMcpServerConfig): string[] {
  const values =
    "command" in config
      ? [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {}), config.cwd]
      : [config.url, ...Object.values(config.headers ?? {})];
  const names = new Set<string>();
  for (const value of values) {
    for (const [, name] of (value ?? "").matchAll(ENV_REFERENCE)) {
      if (name !== undefined && isSynaraVariable(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * A local server gets what provider children get (no `SYNARA_*` control-plane
 * variables, no `NODE_OPTIONS`-style capabilities) minus every provider
 * credential, plus only what the manifest's `env` passes. The provider kind only
 * selects credential grants, and none are left to grant.
 */
function modMcpChildEnvironment(
  explicit: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  return {
    ...buildProviderChildEnvironment({
      provider: "acp",
      baseEnv: withoutProviderCredentialEnvironment(process.env),
    }),
    ...expandRecord(explicit),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface McpTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  /** Idempotent. Never rejects unhandled, so callers may ignore it. */
  close(): Promise<void>;
}

async function initializeSession(
  transport: Pick<McpTransport, "request" | "notify">,
): Promise<void> {
  await transport.request("initialize", INITIALIZE_PARAMS);
  await transport.notify("notifications/initialized", {});
}

class StdioTransport implements McpTransport {
  private readonly serverName: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly writer: JsonRpcStdioWriter;
  private readonly registry: JsonRpcStdioRequestRegistry;
  private readonly framer: JsonRpcStdioFramer;
  private stderrTail = "";
  private exitError: Error | null = null;
  private teardown: Promise<void> | null = null;

  constructor(
    serverName: string,
    config: Extract<ModMcpServerConfig, { readonly command: string }>,
  ) {
    this.serverName = serverName;
    this.child = spawnProcess(
      expandModMcpValue(config.command),
      (config.args ?? []).map((arg) => expandModMcpValue(arg)),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: modMcpChildEnvironment(config.env),
        // Launchers such as `npx` (a `.cmd` shim on Windows) start the real
        // server as a grandchild; owning the group lets teardown reach it.
        ownProcessGroup: true,
        ...(config.cwd ? { cwd: expandModMcpValue(config.cwd) } : {}),
      },
    );
    // A write racing the server's exit fails with EPIPE outside any pending
    // write; without a permanent listener that error would crash Synara.
    this.child.stdin.on("error", () => undefined);
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
    if (this.teardown) return Promise.reject(new ModMcpError(CLOSED_MESSAGE));
    if (this.exitError) return Promise.reject(this.exitError);
    return this.registry.request(method, params, (message) => this.writer.write(message));
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.teardown) throw new ModMcpError(CLOSED_MESSAGE);
    if (this.exitError) throw this.exitError;
    await this.writer.write({ jsonrpc: "2.0", method, params });
  }

  /** Fails pending calls now and settles once the server's process tree is gone. */
  close(): Promise<void> {
    if (this.teardown) return this.teardown;
    const closed = new ModMcpError(CLOSED_MESSAGE);
    this.registry.rejectAll(closed);
    this.writer.close(closed);
    this.teardown = teardownChildProcessTree(this.child).then(
      () => undefined,
      (cause: unknown) => {
        throw new ModMcpError(
          `The "${this.serverName}" MCP server could not be proven stopped: ${errorMessage(cause)}`,
        );
      },
    );
    this.teardown.catch(() => undefined);
    return this.teardown;
  }
}

type HttpOutcome =
  | { readonly kind: "result"; readonly value: unknown }
  /** HTTP 404 to a request that carried this session id: the server forgot it. */
  | { readonly kind: "expired"; readonly sessionId: string }
  /** HTTP 401 or 403 from a server whose sign-in Synara can handle. */
  | ({ readonly kind: "refused" } & ModMcpRefusal);

type ServedOutcome = Exclude<HttpOutcome, { readonly kind: "refused" }>;

/**
 * Incremental `text/event-stream` reader. Hands each event's `data:` lines,
 * joined with newlines, to `onData`, which returns true to stop reading.
 */
class EventStreamParser {
  private partial = "";
  private data: string[] = [];
  private skipLeadingLf = false;

  constructor(private readonly onData: (data: string) => boolean) {}

  push(text: string, ended: boolean): boolean {
    let input = text;
    if (this.skipLeadingLf && input.length > 0) {
      // The previous chunk ended in CR; a LF here belongs to the same CRLF.
      if (input.startsWith("\n")) input = input.slice(1);
      this.skipLeadingLf = false;
    }
    let lineStart = 0;
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (char !== "\n" && char !== "\r") continue;
      const line = this.partial + input.slice(lineStart, index);
      this.partial = "";
      if (char === "\r") {
        if (index + 1 >= input.length) this.skipLeadingLf = true;
        else if (input[index + 1] === "\n") index += 1;
      }
      lineStart = index + 1;
      if (this.line(line)) return true;
    }
    this.partial += input.slice(lineStart);
    if (!ended) return false;
    // Be lenient with a server that ends the stream without a final blank line.
    const last = this.partial;
    this.partial = "";
    if (last && this.line(last)) return true;
    return this.dispatch();
  }

  private line(line: string): boolean {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return false;
    const colon = line.indexOf(":");
    if ((colon === -1 ? line : line.slice(0, colon)) !== "data") return false;
    const value = colon === -1 ? "" : line.slice(colon + 1);
    this.data.push(value.startsWith(" ") ? value.slice(1) : value);
    return false;
  }

  private dispatch(): boolean {
    if (this.data.length === 0) return false;
    const data = this.data.join("\n");
    this.data = [];
    return this.onData(data);
  }
}

class HttpTransport implements McpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly serverName: string;
  private readonly access: ModMcpAccess | null;
  private sessionId: string | null = null;
  private renewal: Promise<void> | null = null;
  private nextId = 1;
  private closed = false;
  private readonly aborts = new Set<AbortController>();

  constructor(
    serverName: string,
    config: Extract<ModMcpServerConfig, { readonly url: string }>,
    access: ModMcpAccess | null,
  ) {
    this.serverName = serverName;
    this.url = expandModMcpValue(config.url);
    if (!/^https?:\/\//iu.test(this.url)) {
      throw new ModMcpError(`The "${serverName}" MCP server URL must be http or https.`);
    }
    this.headers = expandRecord(config.headers);
    this.access = access;
  }

  /**
   * One POST under one deadline. `consume` reads (or cancels) the body inside
   * it, so the timer and `close()` can stop a body that never ends.
   */
  private async post<T>(
    body: Record<string, unknown>,
    sessionId: string | null,
    consume: (response: Response, token: string | null) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new ModMcpError(CLOSED_MESSAGE);
    // Before the deadline starts: a token that ran out may be renewed here.
    const token = this.access === null ? null : await this.access.token();
    if (this.closed) throw new ModMcpError(CLOSED_MESSAGE);
    // The sign-in's token replaces an Authorization header the manifest sets; two
    // spellings of one header would be sent joined, which no server accepts.
    const headers =
      token === null
        ? this.headers
        : {
            ...Object.fromEntries(
              Object.entries(this.headers).filter(
                ([name]) => name.toLowerCase() !== "authorization",
              ),
            ),
            authorization: `Bearer ${token}`,
          };
    const abort = new AbortController();
    this.aborts.add(abort);
    const timer = setTimeout(
      () =>
        abort.abort(
          new ModMcpError(`The "${this.serverName}" MCP server did not answer within 30 s.`),
        ),
      MCP_REQUEST_TIMEOUT_MS,
    );
    try {
      let response: Response;
      try {
        response = await fetch(this.url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", ...body }),
          signal: abort.signal,
        });
      } catch (error) {
        if (abort.signal.reason instanceof ModMcpError) throw abort.signal.reason;
        throw new ModMcpError(
          `The "${this.serverName}" MCP server cannot be reached: ${errorMessage(error)}`,
        );
      }
      try {
        return await consume(response, token);
      } catch (error) {
        if (abort.signal.reason instanceof ModMcpError) throw abort.signal.reason;
        if (error instanceof ModMcpError) throw error;
        throw new ModMcpError(
          `The "${this.serverName}" MCP server dropped its answer: ${errorMessage(error)}`,
        );
      }
    } finally {
      clearTimeout(timer);
      this.aborts.delete(abort);
    }
  }

  /**
   * Reads the body at most `MCP_FRAME_BYTES` long. `onText` returns true to stop
   * early; the rest of the body is cancelled either way.
   */
  private async readBody(
    response: Response,
    method: string,
    onText: (text: string, ended: boolean) => boolean,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      onText("", true);
      return;
    }
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          onText(decoder.decode(), true);
          return;
        }
        bytes += value.byteLength;
        if (bytes > MCP_FRAME_BYTES) {
          throw new ModMcpError(
            `The "${this.serverName}" MCP server answered ${method} with more than 8 MB.`,
          );
        }
        if (onText(decoder.decode(value, { stream: true }), false)) return;
      }
    } finally {
      // Stops an event stream the server keeps open; a no-op once the body ended.
      void reader.cancel().catch(() => undefined);
    }
  }

  private async readAnswer(
    response: Response,
    method: string,
    id: number,
  ): Promise<Record<string, unknown> | null> {
    let answer: Record<string, unknown> | null = null;
    const take = (raw: string): boolean => {
      try {
        const message = asRecord(JSON.parse(raw));
        if (message?.id === id) answer = message;
      } catch {
        // Not JSON-RPC; keep looking.
      }
      return answer !== null;
    };
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const parser = new EventStreamParser(take);
      await this.readBody(response, method, (text, ended) => parser.push(text, ended));
    } else {
      let text = "";
      await this.readBody(response, method, (chunk, ended) => {
        text += chunk;
        if (ended) take(text);
        return false;
      });
    }
    return answer;
  }

  private httpError(method: string, status: number): ModMcpError {
    return new ModMcpError(
      `The "${this.serverName}" MCP server answered ${method} with HTTP ${status}.`,
    );
  }

  private send(method: string, params: unknown): Promise<HttpOutcome> {
    const id = this.nextId++;
    const sessionId = this.sessionId;
    return this.post({ id, method, params }, sessionId, async (response, token) => {
      if (this.access !== null && (response.status === 401 || response.status === 403)) {
        void response.body?.cancel().catch(() => undefined);
        return {
          kind: "refused",
          status: response.status,
          challenge: response.headers.get("www-authenticate"),
          token,
        };
      }
      if (this.sessionId === sessionId) {
        this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
      }
      if (response.status === 404 && sessionId !== null) {
        void response.body?.cancel().catch(() => undefined);
        return { kind: "expired", sessionId };
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw this.httpError(method, response.status);
      }
      const message = await this.readAnswer(response, method, id);
      if (message === null) {
        throw new ModMcpError(`The "${this.serverName}" MCP server sent no answer to ${method}.`);
      }
      const error = asRecord(message.error);
      if (error) {
        throw new ModMcpError(
          `The "${this.serverName}" MCP server failed ${method}: ${String(error.message ?? "error")}`,
        );
      }
      return { kind: "result", value: message.result };
    });
  }

  /**
   * Sends a request, and once more when the server refused the first one and the
   * sign-in has a new token to try. A refusal that stands fails the request, as a
   * need to sign in when that is what it is.
   */
  private async sendSignedIn(method: string, params: unknown): Promise<ServedOutcome> {
    const outcome = await this.send(method, params);
    if (outcome.kind !== "refused") return outcome;
    if (!(await this.access?.refused(outcome))) throw this.httpError(method, outcome.status);
    const again = await this.send(method, params);
    if (again.kind !== "refused") return again;
    // Lets the sign-in learn that its new token is refused too; it may throw.
    await this.access?.refused(again);
    throw this.httpError(method, again.status);
  }

  private async requestOnce(method: string, params: unknown): Promise<unknown> {
    const outcome = await this.sendSignedIn(method, params);
    if (outcome.kind === "expired") throw this.httpError(method, 404);
    return outcome.value;
  }

  /** Starts a new session in place of `stale`, once however many calls saw it expire. */
  private renewSession(stale: string): Promise<void> {
    if (this.sessionId !== stale) return this.renewal ?? Promise.resolve();
    this.sessionId = null;
    const renewal = initializeSession({
      request: (method, params) => this.requestOnce(method, params),
      notify: (method, params) => this.notify(method, params),
    });
    this.renewal = renewal;
    const settle = () => {
      if (this.renewal === renewal) this.renewal = null;
    };
    renewal.then(settle, settle);
    return renewal;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.renewal) await this.renewal.catch(() => undefined);
    const outcome = await this.sendSignedIn(method, params);
    if (outcome.kind === "result") return outcome.value;
    // The server restarted or expired the session: start a new one and retry once.
    await this.renewSession(outcome.sessionId);
    return this.requestOnce(method, params);
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.post({ method, params }, this.sessionId, async (response) => {
      // Nothing to read from a notification's answer; release the connection.
      void response.body?.cancel().catch(() => undefined);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    const closed = new ModMcpError(CLOSED_MESSAGE);
    for (const abort of this.aborts) abort.abort(closed);
    this.aborts.clear();
    return Promise.resolve();
  }
}

/** One MCP server of one mod. Connects on first use; `close()` ends it. */
export class ModMcpClient {
  private readonly serverName: string;
  private readonly config: ModMcpServerConfig;
  private readonly refusedEnv: ReadonlyArray<string>;
  private readonly access: ModMcpAccess | null;
  /** Set before the handshake so `close()` can stop a server that is still starting. */
  private transport: McpTransport | null = null;
  private connection: Promise<McpTransport> | null = null;
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;

  /** `access`: the person's sign-in to a remote server, when Synara handles one for it. */
  constructor(serverName: string, config: ModMcpServerConfig, access: ModMcpAccess | null = null) {
    this.serverName = serverName;
    this.config = config;
    this.refusedEnv = refusedEnvNames(config);
    this.access = access;
  }

  private connect(): Promise<McpTransport> {
    if (this.closed) return Promise.reject(new ModMcpError(CLOSED_MESSAGE));
    if (this.connection) return this.connection;
    const transport: McpTransport =
      "command" in this.config
        ? new StdioTransport(this.serverName, this.config)
        : new HttpTransport(this.serverName, this.config, this.access);
    this.transport = transport;
    const connection = this.handshake(transport);
    this.connection = connection;
    // A failed start can be retried by the next call.
    connection.catch(() => {
      if (this.connection !== connection) return;
      this.connection = null;
      this.transport = null;
    });
    return connection;
  }

  private async handshake(transport: McpTransport): Promise<McpTransport> {
    try {
      await initializeSession(transport);
      if (this.closed) throw new ModMcpError(CLOSED_MESSAGE);
      return transport;
    } catch (error) {
      void this.retire(transport);
      throw error;
    }
  }

  private retire(transport: McpTransport): Promise<void> {
    const stopped = transport.close();
    this.stopping.add(stopped);
    const forget = () => this.stopping.delete(stopped);
    stopped.then(forget, forget);
    return stopped;
  }

  /** Names the `${env:SYNARA_*}` references that were left empty, if any. */
  private explain(error: unknown): unknown {
    if (!(error instanceof ModMcpError) || this.refusedEnv.length === 0) return error;
    if (error instanceof ModMcpSignInNeededError) return error;
    const names = this.refusedEnv.map((name) => `\${env:${name}}`).join(", ");
    return new ModMcpError(
      `${error.message} (${names} ${this.refusedEnv.length === 1 ? "was" : "were"} left empty: mods cannot read Synara's own SYNARA_ variables.)`,
    );
  }

  async listTools(): Promise<ModMcpTool[]> {
    try {
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
    } catch (error) {
      throw this.explain(error);
    }
  }

  async callTool(tool: string, args: unknown): Promise<ModMcpCallResult> {
    try {
      const transport = await this.connect();
      const result = asRecord(
        await transport.request("tools/call", { name: tool, arguments: asRecord(args) ?? {} }),
      );
      return {
        content: Array.isArray(result?.content) ? result.content : [],
        structuredContent: result?.structuredContent ?? null,
        isError: result?.isError === true,
      };
    } catch (error) {
      throw this.explain(error);
    }
  }

  /**
   * Fails pending calls and stops the server, a starting one included. Safe to
   * call without awaiting; the promise settles once every process this client
   * started is gone, and rejects when that cannot be proven.
   */
  close(): Promise<void> {
    this.closed = true;
    if (this.transport) void this.retire(this.transport);
    this.transport = null;
    this.connection = null;
    const stopped = Promise.all(this.stopping).then(() => undefined);
    stopped.catch(() => undefined);
    return stopped;
  }
}
