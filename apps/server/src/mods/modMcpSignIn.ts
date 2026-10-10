// FILE: modMcpSignIn.ts
// Purpose: Keeps each mod's sign-ins to its remote MCP servers. Notices that a
//          server asks for one, runs the browser sign-in the person starts
//          (listening on this computer for the browser's return), stores the
//          token outside the mod and renews it. A sign-in belongs to one mod
//          and one server address, and its token is sent nowhere else.
// Layer: Mods runtime

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  MOD_MCP_SIGN_IN_PATH,
  MOD_MCP_SIGN_IN_PORT,
  type ModLogLevel,
  type ModMcpServerConfig,
  type ModMcpSignIn,
} from "@synara/contracts";

import {
  expandModMcpValue,
  type ModMcpAccess,
  type ModMcpRefusal,
  ModMcpSignInNeededError,
} from "./modMcpClient.ts";
import {
  buildModMcpAuthorizationUrl,
  canSignInTo,
  createModMcpPkce,
  createModMcpState,
  discoverModMcpAuthorization,
  exchangeModMcpCode,
  type ModMcpAuthorization,
  type ModMcpClientIdentity,
  ModMcpOAuthError,
  ModMcpOAuthUnreachableError,
  type ModMcpTokens,
  modMcpResourceOf,
  type ModOAuthFetch,
  refreshModMcpTokens,
  resolveModMcpClient,
} from "./modMcpOAuth.ts";

const SIGN_IN_TTL_MS = 10 * 60_000;
const SIGN_IN_PENDING_LIMIT = 8;
/** A token this close to running out is renewed before it is sent. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;
/** How long "this server does not use sign-in" is believed before asking it again. */
const NOT_SIGN_IN_TTL_MS = 60_000;
const CODE_CHARS_LIMIT = 4_096;
const STORE_VERSION = 1;

type RemoteConfig = Extract<ModMcpServerConfig, { readonly url: string }>;

/** Where sign-ins are kept: one secret per mod, removed with the mod. */
export interface ModSecretVault {
  readonly read: (modId: string) => Promise<string | null>;
  readonly write: (modId: string, value: string) => Promise<void>;
  readonly remove: (modId: string) => Promise<void>;
}

/** A vault that forgets when Synara stops, for a manager built without one. */
export function makeMemoryModSecretVault(): ModSecretVault {
  const values = new Map<string, string>();
  return {
    read: async (modId) => values.get(modId) ?? null,
    write: async (modId, value) => {
      values.set(modId, value);
    },
    remove: async (modId) => {
      values.delete(modId);
    },
  };
}

/** One sign-in as stored. `serverUrl` is the address it was made for and the only one it is sent to. */
interface StoredSession {
  readonly serverUrl: string;
  readonly resource: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
}

interface ServerState {
  session: StoredSession | null;
  /** Set while calls are refused until the person signs in; `detail` says why, when known. */
  needed: { readonly detail: string | null } | null;
  /** Until when the server is believed not to use sign-in at all. */
  openUntil: number;
  renewal: Promise<string> | null;
  discovery: Promise<boolean> | null;
}

interface PendingSignIn {
  readonly modId: string;
  /** The mod's sign-ins as of the start; a mod forgotten since gets no token. */
  readonly epoch: number;
  readonly server: string;
  readonly serverUrl: string;
  readonly authorization: ModMcpAuthorization;
  readonly client: ModMcpClientIdentity;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface CallbackListener {
  readonly port: number;
  /** Opened on a free port because the usual one was taken. */
  readonly spare: boolean;
  readonly server: Server;
  readonly pending: Map<string, PendingSignIn>;
  /** Sign-ins being prepared that will wait here; the listener stays open for them. */
  holds: number;
}

export interface ModMcpSignInsOptions {
  readonly vault: ModSecretVault;
  /** A mod's sign-ins changed. `redraw`: its views can now draw what they could not, or no longer can. */
  readonly onChange: (modId: string, redraw: boolean) => void;
  readonly log: (modId: string, level: ModLogLevel, message: string) => void;
  readonly fetch?: ModOAuthFetch | undefined;
  /** The port to listen on for the browser's return. Tests pass 0 for any free port. */
  readonly port?: number | undefined;
  readonly now?: (() => number) | undefined;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (value === null || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  const text = (key: string) => typeof session[key] === "string" && session[key] !== "";
  const textOrNull = (key: string) => session[key] === null || typeof session[key] === "string";
  return (
    text("serverUrl") &&
    text("resource") &&
    text("issuer") &&
    text("tokenEndpoint") &&
    text("clientId") &&
    text("accessToken") &&
    textOrNull("clientSecret") &&
    textOrNull("refreshToken") &&
    (session.expiresAt === null || typeof session.expiresAt === "number")
  );
}

function hasAuthorizationHeader(config: RemoteConfig): boolean {
  return Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // The listener closes after the last sign-in; a kept connection would outlive it.
  connection: "close",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

/** The page the browser lands on. Both texts are fixed: nothing from the request is echoed. */
function page(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#aaa}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

const SIGNED_IN_PAGE = page("Signed in", "You can close this tab and go back to Synara.");
const NOT_SIGNED_IN_PAGE = page(
  "The sign-in did not finish",
  "Go back to Synara and try again. The mod's log in Settings → Mods says what went wrong.",
);
const STALE_PAGE = page(
  "This sign-in page is out of date",
  "Go back to Synara and start the sign-in again.",
);

export class ModMcpSignIns {
  private readonly options: ModMcpSignInsOptions;
  private readonly states = new Map<string, Map<string, ServerState>>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly listeners = new Map<number, CallbackListener>();
  /** Bumped when a mod's sign-ins are forgotten, so one in flight is not kept after. */
  private readonly epochs = new Map<string, number>();
  /** Listeners open one after another, so two sign-ins starting together share one. */
  private opening: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(options: ModMcpSignInsOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private state(modId: string, server: string): ServerState {
    let servers = this.states.get(modId);
    if (!servers) {
      servers = new Map();
      this.states.set(modId, servers);
    }
    let state = servers.get(server);
    if (!state) {
      state = { session: null, needed: null, openUntil: 0, renewal: null, discovery: null };
      servers.set(server, state);
    }
    return state;
  }

  /** Reads a mod's stored sign-ins once; later calls wait for the same read. */
  load(modId: string): Promise<void> {
    let load = this.loads.get(modId);
    if (!load) {
      load = this.options.vault
        .read(modId)
        .then((stored) => {
          if (stored === null) return;
          const parsed = JSON.parse(stored) as { version?: unknown; servers?: unknown };
          if (parsed.version !== STORE_VERSION || parsed.servers === null) return;
          for (const [server, session] of Object.entries(parsed.servers ?? {})) {
            if (isStoredSession(session)) this.state(modId, server).session = session;
          }
        })
        // An unreadable store means signing in again, not a mod that cannot start.
        .catch(() => undefined);
      this.loads.set(modId, load);
    }
    return load;
  }

  /** Writes of one mod run one after another, so the last state is the one kept. */
  private save(modId: string): Promise<void> {
    const write = (this.writes.get(modId) ?? Promise.resolve()).then(async () => {
      const servers: Record<string, StoredSession> = {};
      for (const [server, state] of this.states.get(modId) ?? []) {
        if (state.session !== null) servers[server] = state.session;
      }
      if (Object.keys(servers).length === 0) await this.options.vault.remove(modId);
      else {
        await this.options.vault.write(modId, JSON.stringify({ version: STORE_VERSION, servers }));
      }
    });
    const settled = write.catch((error: unknown) => {
      this.options.log(modId, "error", `A sign-in could not be saved: ${errorMessage(error)}`);
    });
    this.writes.set(modId, settled);
    return settled;
  }

  /** The server's address as a sign-in is bound to it; null when it cannot have one. */
  private serverUrlOf(config: RemoteConfig): string | null {
    const expanded = expandModMcpValue(config.url);
    return canSignInTo(expanded) ? modMcpResourceOf(expanded).href : null;
  }

  /** The stored sign-in, unless it was made for another address than the mod now names. */
  private sessionFor(state: ServerState, serverUrl: string): StoredSession | null {
    return state.session !== null && state.session.serverUrl === serverUrl ? state.session : null;
  }

  private needSignIn(modId: string, server: string, detail: string | null): void {
    const state = this.state(modId, server);
    const changed = state.needed === null || state.needed.detail !== detail;
    state.needed = { detail };
    if (changed) this.options.onChange(modId, false);
  }

  private signInNeeded(server: string, host: string): ModMcpSignInNeededError {
    return new ModMcpSignInNeededError(
      `The "${server}" MCP server (${host}) needs a sign-in first. Synara shows a Sign in button in the mod's view and in Settings → Mods; the call works after that.`,
    );
  }

  /** Drops a sign-in the server no longer takes, so the person is asked again. */
  private async expire(modId: string, server: string, detail: string): Promise<void> {
    const state = this.state(modId, server);
    state.session = null;
    this.needSignIn(modId, server, detail);
    await this.save(modId);
  }

  private renew(modId: string, server: string, session: StoredSession): Promise<string> {
    const state = this.state(modId, server);
    if (state.renewal) return state.renewal;
    const renewal = (async () => {
      const tokens = await refreshModMcpTokens({
        authorization: session,
        client: session,
        refreshToken: session.refreshToken ?? "",
        fetch: this.options.fetch,
        now: this.now(),
      });
      // A sign-out or a new sign-in while this ran wins over it.
      if (state.session !== session) throw new ModMcpOAuthError("The sign-in changed.");
      state.session = {
        ...session,
        accessToken: tokens.accessToken,
        // Servers that rotate refresh tokens send the next one; the others keep the old.
        refreshToken: tokens.refreshToken ?? session.refreshToken,
        expiresAt: tokens.expiresAt,
      };
      await this.save(modId);
      return tokens.accessToken;
    })();
    state.renewal = renewal;
    const settle = () => {
      if (state.renewal === renewal) state.renewal = null;
    };
    renewal.then(settle, settle);
    return renewal;
  }

  /**
   * The sign-in an MCP client of this mod should use for a remote server; null
   * when the manifest sends its own Authorization header and declares no sign-in.
   */
  access(modId: string, server: string, config: RemoteConfig): ModMcpAccess | null {
    const serverUrl = this.serverUrlOf(config);
    if (serverUrl === null) return null;
    const declared = config.oauth !== undefined;
    if (!declared && hasAuthorizationHeader(config)) return null;
    const host = new URL(serverUrl).host;

    const token = async (): Promise<string | null> => {
      await this.load(modId);
      // Looked up on every call: forgetting a mod's sign-ins replaces its state.
      const state = this.state(modId, server);
      const session = this.sessionFor(state, serverUrl);
      if (session === null) {
        if (state.session !== null) {
          // Made for another address: not this server's to receive.
          state.session = null;
          await this.save(modId);
        }
        if (!declared && state.needed === null) return null;
        if (state.needed === null) this.needSignIn(modId, server, null);
        throw this.signInNeeded(server, host);
      }
      if (session.expiresAt === null || session.expiresAt - TOKEN_EXPIRY_MARGIN_MS > this.now()) {
        return session.accessToken;
      }
      if (session.refreshToken !== null) {
        const renewed = await this.renew(modId, server, session).catch(() => null);
        if (renewed !== null) return renewed;
      }
      await this.expire(modId, server, "The sign-in ran out.");
      throw this.signInNeeded(server, host);
    };

    const refused = async (refusal: ModMcpRefusal): Promise<boolean> => {
      const state = this.state(modId, server);
      if (refusal.token !== null) {
        // 403 with a token is the server saying no to this account, not asking who it is.
        if (refusal.status !== 401) return false;
        const session = this.sessionFor(state, serverUrl);
        if (session !== null && session.accessToken !== refusal.token) return true;
        if (session?.refreshToken) {
          const renewed = await this.renew(modId, server, session).catch(() => null);
          if (renewed !== null && renewed !== refusal.token) return true;
        }
        await this.expire(modId, server, "The server no longer accepts the sign-in.");
        throw this.signInNeeded(server, host);
      }
      if (state.openUntil > this.now()) return false;
      state.discovery ??= discoverModMcpAuthorization({
        serverUrl,
        challenge: refusal.challenge,
        fetch: this.options.fetch,
      })
        .then(
          (authorization) => {
            if (authorization === null) {
              state.openUntil = this.now() + NOT_SIGN_IN_TTL_MS;
              return false;
            }
            this.needSignIn(modId, server, null);
            return true;
          },
          (error: unknown) => {
            // Nothing learned: this call fails as it would have, and the next one asks again.
            if (error instanceof ModMcpOAuthUnreachableError) return false;
            // It asks for a sign-in Synara will not do; the row says why.
            this.needSignIn(modId, server, errorMessage(error));
            return true;
          },
        )
        .finally(() => {
          state.discovery = null;
        });
      if (await state.discovery) throw this.signInNeeded(server, host);
      return false;
    };

    return { token, refused };
  }

  /** What Settings and the mod's views show for each server that asks for a sign-in. */
  summary(
    modId: string,
    servers: Readonly<Record<string, ModMcpServerConfig>> | undefined,
  ): ModMcpSignIn[] {
    const entries: ModMcpSignIn[] = [];
    for (const [server, config] of Object.entries(servers ?? {})) {
      if (!("url" in config)) continue;
      const serverUrl = this.serverUrlOf(config);
      if (serverUrl === null) continue;
      const state = this.states.get(modId)?.get(server);
      const host = new URL(serverUrl).host;
      const session = state ? this.sessionFor(state, serverUrl) : null;
      const ranOut =
        session !== null &&
        session.refreshToken === null &&
        session.expiresAt !== null &&
        session.expiresAt <= this.now();
      if (ranOut) {
        entries.push({ server, host, state: "needed", detail: "The sign-in ran out." });
      } else if (session !== null) {
        entries.push({ server, host, state: "signed-in", detail: null });
      } else if (state?.needed || config.oauth !== undefined) {
        entries.push({ server, host, state: "needed", detail: state?.needed?.detail ?? null });
      }
    }
    return entries;
  }

  /**
   * The mod starts again, perhaps with another manifest: what was learned about
   * its servers (that one waits for a sign-in, why one could not start) is asked
   * anew. Sign-ins themselves stay.
   */
  restarted(modId: string): void {
    for (const state of this.states.get(modId)?.values() ?? []) {
      state.needed = null;
      state.openUntil = 0;
    }
  }

  /** Whether calls to the server are refused until the person signs in. */
  needsSignIn(modId: string, server: string, config: ModMcpServerConfig): boolean {
    return this.summary(modId, { [server]: config }).some((entry) => entry.state === "needed");
  }

  // ── The browser's return ───────────────────────────────────────────

  private pendingCount(): number {
    let count = 0;
    for (const listener of this.listeners.values()) count += listener.pending.size;
    return count;
  }

  private open(port: number, spare: boolean): Promise<CallbackListener> {
    return new Promise((resolve, reject) => {
      let listener: CallbackListener | null = null;
      const server = createServer((request, response) => {
        if (listener !== null) void this.handleReturn(listener, request, response);
      });
      server.once("error", reject);
      // Only this computer can reach it; the browser returning is on this computer.
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        server.on("error", () => undefined);
        const address = server.address();
        listener = {
          port: address !== null && typeof address === "object" ? address.port : port,
          spare,
          server,
          pending: new Map(),
          holds: 0,
        };
        this.listeners.set(listener.port, listener);
        resolve(listener);
      });
    });
  }

  /**
   * The listener a sign-in will return to, held open for the caller: it must
   * give the hold back (`holds -= 1`, then `release`) once its sign-in waits there.
   */
  private hold(modId: string, wanted: number | undefined): Promise<CallbackListener> {
    const held = this.opening.then(async () => {
      const listener = await this.listen(modId, wanted);
      listener.holds += 1;
      return listener;
    });
    this.opening = held.catch(() => undefined);
    return held;
  }

  private async listen(modId: string, wanted: number | undefined): Promise<CallbackListener> {
    const port = wanted ?? this.options.port ?? MOD_MCP_SIGN_IN_PORT;
    const existing = port === 0 ? undefined : this.listeners.get(port);
    if (existing) return existing;
    try {
      return await this.open(port, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw new ModMcpOAuthError(
          `Synara could not listen for the browser's return: ${errorMessage(error)}`,
        );
      }
      if (wanted !== undefined) {
        throw new ModMcpOAuthError(
          `Port ${wanted}, where this server's sign-in returns to, is in use on this computer.`,
        );
      }
      for (const listener of this.listeners.values()) if (listener.spare) return listener;
      const spare = await this.open(0, true);
      this.options.log(
        modId,
        "warn",
        `Port ${port} is in use, so this sign-in returns to port ${spare.port}. A client id registered for port ${port} may be refused.`,
      );
      return spare;
    }
  }

  private release(listener: CallbackListener): void {
    if (listener.pending.size > 0 || listener.holds > 0) return;
    if (this.listeners.get(listener.port) === listener) this.listeners.delete(listener.port);
    listener.server.close();
  }

  private drop(listener: CallbackListener, state: string): PendingSignIn | null {
    const pending = listener.pending.get(state) ?? null;
    if (pending === null) return null;
    listener.pending.delete(state);
    clearTimeout(pending.timer);
    return pending;
  }

  private cancel(match: (pending: PendingSignIn) => boolean): void {
    // Deleting the entry being visited is safe while iterating a Map.
    for (const listener of this.listeners.values()) {
      for (const [state, pending] of listener.pending) {
        if (match(pending)) this.drop(listener, state);
      }
      this.release(listener);
    }
  }

  private async handleReturn(
    listener: CallbackListener,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const respond = (status: number, body: string) => {
      response.writeHead(status, PAGE_HEADERS);
      response.end(body);
    };
    const port = listener.port;
    // A page on another site can name this address through a hostname of its own.
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      respond(400, STALE_PAGE);
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method !== "GET" || url.pathname !== MOD_MCP_SIGN_IN_PATH) {
      respond(404, STALE_PAGE);
      return;
    }
    // A state opens one sign-in once.
    const pending = this.drop(listener, url.searchParams.get("state") ?? "");
    if (pending === null) {
      respond(400, STALE_PAGE);
      return;
    }
    try {
      const tokens = await this.finish(pending, url.searchParams);
      await this.keep(pending, tokens);
      respond(200, SIGNED_IN_PAGE);
    } catch (error) {
      if (this.epochOf(pending.modId) === pending.epoch) {
        const message = errorMessage(error);
        this.options.log(pending.modId, "error", `The sign-in did not finish: ${message}`);
        this.needSignIn(pending.modId, pending.server, message);
      }
      respond(400, NOT_SIGNED_IN_PAGE);
    } finally {
      this.release(listener);
    }
  }

  private epochOf(modId: string): number {
    return this.epochs.get(modId) ?? 0;
  }

  private async finish(pending: PendingSignIn, answer: URLSearchParams): Promise<ModMcpTokens> {
    const host = new URL(pending.authorization.issuer).host;
    const refusal = answer.get("error");
    if (refusal !== null) {
      const said = (answer.get("error_description") ?? refusal).slice(0, 200);
      throw new ModMcpOAuthError(`${host} did not sign you in (${JSON.stringify(said)}).`);
    }
    // An answer from another server than the one asked would mix two sign-ins up.
    const issuer = answer.get("iss");
    if (
      (issuer !== null && issuer.replace(/\/+$/u, "") !== pending.authorization.issuer) ||
      (issuer === null && pending.authorization.sendsIssuer)
    ) {
      throw new ModMcpOAuthError(`The answer did not come from ${host}.`);
    }
    const code = answer.get("code");
    if (code === null || code.length === 0 || code.length > CODE_CHARS_LIMIT) {
      throw new ModMcpOAuthError(`${host} sent the browser back without a code.`);
    }
    return exchangeModMcpCode({
      authorization: pending.authorization,
      client: pending.client,
      redirectUri: pending.redirectUri,
      code,
      verifier: pending.verifier,
      fetch: this.options.fetch,
      now: this.now(),
    });
  }

  private async keep(pending: PendingSignIn, tokens: ModMcpTokens): Promise<void> {
    // The mod was removed or replaced while the person was signing in.
    if (this.epochOf(pending.modId) !== pending.epoch) {
      throw new ModMcpOAuthError("The mod changed while you were signing in.");
    }
    const state = this.state(pending.modId, pending.server);
    state.session = {
      serverUrl: pending.serverUrl,
      resource: pending.authorization.resource,
      issuer: pending.authorization.issuer,
      tokenEndpoint: pending.authorization.tokenEndpoint,
      clientId: pending.client.clientId,
      clientSecret: pending.client.clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
    state.needed = null;
    await this.save(pending.modId);
    this.options.log(
      pending.modId,
      "info",
      `Signed in to ${new URL(pending.serverUrl).host} for the "${pending.server}" MCP server.`,
    );
    this.options.onChange(pending.modId, true);
  }

  /**
   * Starts a sign-in and returns the page the person signs in on. It finishes
   * when their browser returns to this computer, within ten minutes. Why one
   * could not start also goes to the mod's row and log, where the agent writing
   * the mod reads it.
   */
  async begin(modId: string, server: string, config: ModMcpServerConfig): Promise<string> {
    try {
      return await this.start(modId, server, config);
    } catch (error) {
      const message = errorMessage(error);
      this.options.log(modId, "error", `The sign-in to "${server}" could not start: ${message}`);
      this.needSignIn(modId, server, message);
      throw error;
    }
  }

  private async start(modId: string, server: string, config: ModMcpServerConfig): Promise<string> {
    if (this.stopped) throw new ModMcpOAuthError("Synara is closing.");
    if (!("url" in config)) {
      throw new ModMcpOAuthError(`"${server}" is a local MCP server; it has no sign-in.`);
    }
    const serverUrl = this.serverUrlOf(config);
    if (serverUrl === null) {
      throw new ModMcpOAuthError("Sign-in works only with an https server.");
    }
    await this.load(modId);
    // One sign-in per server: starting again replaces the page opened before.
    this.cancel((pending) => pending.modId === modId && pending.server === server);
    if (this.pendingCount() >= SIGN_IN_PENDING_LIMIT) {
      throw new ModMcpOAuthError(
        "Too many sign-ins are waiting for the browser. Finish one first.",
      );
    }
    const host = new URL(serverUrl).host;
    const authorization = await discoverModMcpAuthorization({
      serverUrl,
      challenge: null,
      fetch: this.options.fetch,
    });
    if (authorization === null) {
      throw new ModMcpOAuthError(`${host} does not say how to sign in to it.`);
    }
    const epoch = this.epochOf(modId);
    const listener = await this.hold(modId, config.oauth?.callbackPort);
    try {
      const redirectUri = `http://127.0.0.1:${listener.port}${MOD_MCP_SIGN_IN_PATH}`;
      const client = await resolveModMcpClient({
        authorization,
        config: config.oauth,
        redirectUri,
        modId,
        fetch: this.options.fetch,
      });
      const pkce = createModMcpPkce();
      const state = createModMcpState();
      listener.pending.set(state, {
        modId,
        epoch,
        server,
        serverUrl,
        authorization,
        client,
        redirectUri,
        verifier: pkce.verifier,
        timer: setTimeout(() => {
          this.drop(listener, state);
          this.release(listener);
        }, SIGN_IN_TTL_MS),
      });
      return buildModMcpAuthorizationUrl({
        authorization,
        client,
        redirectUri,
        state,
        challenge: pkce.challenge,
        scopes: config.oauth?.scopes,
      });
    } finally {
      listener.holds -= 1;
      this.release(listener);
    }
  }

  /** Forgets a mod's sign-in to one server; its calls are refused until the next one. */
  async signOut(modId: string, server: string): Promise<void> {
    await this.load(modId);
    this.cancel((pending) => pending.modId === modId && pending.server === server);
    const state = this.state(modId, server);
    state.session = null;
    state.needed = { detail: null };
    await this.save(modId);
    this.options.onChange(modId, true);
  }

  /** Forgets every sign-in of a mod: its folder is gone, or its code was replaced by an import. */
  async forget(modId: string): Promise<void> {
    this.cancel((pending) => pending.modId === modId);
    this.epochs.set(modId, this.epochOf(modId) + 1);
    const had = [...(this.states.get(modId)?.values() ?? [])].some(
      (state) => state.session !== null,
    );
    this.states.delete(modId);
    this.loads.delete(modId);
    await (this.writes.get(modId) ?? Promise.resolve());
    await this.options.vault.remove(modId).catch(() => undefined);
    if (had) this.options.onChange(modId, true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancel(() => true);
    for (const listener of this.listeners.values()) listener.server.close();
    this.listeners.clear();
    await Promise.all(this.writes.values());
  }
}
