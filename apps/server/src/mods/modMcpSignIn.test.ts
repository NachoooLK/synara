// FILE: modMcpSignIn.test.ts
// Purpose: Signs in to a real (fake, local) MCP server that asks for OAuth: the
//          server refuses, Synara finds out how to sign in, a "browser" follows
//          the sign-in page back to Synara, and calls then carry the token. Also
//          covers what keeps a token where it belongs: one mod, one address.
// Layer: Mods runtime tests

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { ModLogLevel, ModMcpServerConfig, ModsStreamEvent } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModManager } from "./modManager.ts";
import {
  MOD_MCP_SIGN_IN_NEEDED_CODE,
  ModMcpClient,
  ModMcpSignInNeededError,
} from "./modMcpClient.ts";
import type { ModOAuthFetch } from "./modMcpOAuth.ts";
import { makeMemoryModSecretVault, ModMcpSignIns, type ModSecretVault } from "./modMcpSignIn.ts";

type RemoteConfig = Extract<ModMcpServerConfig, { readonly url: string }>;

interface FakeOptions {
  /** Whether the server publishes how to sign in to it. */
  metadata: boolean;
  /** Whether apps can register themselves. */
  registration: boolean;
  pkce: boolean;
  /** What a request without a good token gets. */
  refusal: 401 | 403;
  /** Whether that refusal says where the sign-in is described. */
  challenge: boolean;
  expiresIn: number | null;
  refresh: boolean;
  /** Sends MCP requests on to another address, as a misbehaving server might. */
  redirectTo: string | null;
  /** The address the server's document claims to describe. */
  resource: string | null;
}

interface FakeServer {
  readonly origin: string;
  readonly url: string;
  readonly options: FakeOptions;
  /** Tokens the MCP endpoint accepts. */
  readonly tokens: Set<string>;
  readonly clients: Set<string>;
  readonly requests: Array<{ method: string; path: string; authorization: string | null }>;
  readonly authorizations: URLSearchParams[];
  readonly registrations: Array<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

async function startFakeServer(overrides: Partial<FakeOptions> = {}): Promise<FakeServer> {
  const options: FakeOptions = {
    metadata: true,
    registration: true,
    pkce: true,
    refusal: 401,
    challenge: true,
    expiresIn: 3_600,
    refresh: false,
    redirectTo: null,
    resource: null,
    ...overrides,
  };
  const tokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const clients = new Set<string>(["known-client"]);
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const requests: FakeServer["requests"] = [];
  const authorizations: URLSearchParams[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  let counter = 0;
  let origin = "";

  const issue = () => {
    counter += 1;
    const accessToken = `access-${counter}`;
    tokens.add(accessToken);
    const refreshToken = `refresh-${counter}`;
    if (options.refresh) refreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      ...(options.expiresIn === null ? {} : { expires_in: options.expiresIn }),
      ...(options.refresh ? { refresh_token: refreshToken } : {}),
    };
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "",
        path: url.pathname,
        authorization: request.headers.authorization ?? null,
      });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        if (!options.metadata) return json(404, {});
        return json(200, {
          resource: options.resource ?? `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (!options.metadata) return json(404, {});
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.registration ? { registration_endpoint: `${origin}/register` } : {}),
          code_challenge_methods_supported: options.pkce ? ["S256"] : ["plain"],
          response_types_supported: ["code"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        counter += 1;
        const clientId = `registered-${counter}`;
        clients.add(clientId);
        registrations.push(JSON.parse(body) as Record<string, unknown>);
        return json(201, { client_id: clientId });
      }
      if (url.pathname === "/authorize") {
        const query = url.searchParams;
        authorizations.push(query);
        const clientId = query.get("client_id") ?? "";
        if (!clients.has(clientId)) return json(400, { error: "invalid_client" });
        counter += 1;
        const code = `code-${counter}`;
        codes.set(code, {
          challenge: query.get("code_challenge") ?? "",
          redirectUri: query.get("redirect_uri") ?? "",
          clientId,
        });
        const back = new URL(query.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", query.get("state") ?? "");
        response.writeHead(302, { location: back.href });
        response.end();
        return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "authorization_code") {
          const grant = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const challenge = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url");
          if (
            !grant ||
            challenge !== grant.challenge ||
            form.get("redirect_uri") !== grant.redirectUri ||
            form.get("client_id") !== grant.clientId
          ) {
            return json(400, { error: "invalid_grant", error_description: "The code is no good." });
          }
          return json(200, issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          if (!refreshTokens.delete(form.get("refresh_token") ?? "")) {
            return json(400, { error: "invalid_grant" });
          }
          return json(200, issue());
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        if (options.redirectTo !== null) {
          response.writeHead(307, { location: options.redirectTo });
          response.end();
          return;
        }
        const authorization = request.headers.authorization ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
        if (token === null || !tokens.has(token)) {
          return json(
            options.refusal,
            { error: "Sign in first." },
            options.challenge
              ? {
                  "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
                }
              : {},
          );
        }
        const message = JSON.parse(body) as { id?: number; method: string };
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        const result =
          message.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: JSON.stringify({ answered: true }) }] }
              : {};
        return json(200, { jsonrpc: "2.0", id: message.id, result });
      }
      return json(404, {});
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: `${origin}/mcp`,
    options,
    tokens,
    clients,
    requests,
    authorizations,
    registrations,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** What the person's browser does: opens the sign-in page and follows it back to Synara. */
async function finishInBrowser(signInUrl: string): Promise<Response> {
  const page = await fetch(signInUrl, { redirect: "manual" });
  const back = page.headers.get("location");
  if (back === null)
    throw new Error(`The sign-in page did not send the browser back (${page.status}).`);
  return fetch(back);
}

const servers: FakeServer[] = [];
const stops: Array<() => Promise<void>> = [];

async function fakeServer(overrides: Partial<FakeOptions> = {}): Promise<FakeServer> {
  const server = await startFakeServer(overrides);
  servers.push(server);
  return server;
}

interface Harness {
  readonly signIns: ModMcpSignIns;
  readonly vault: ModSecretVault;
  readonly changes: Array<{ modId: string; redraw: boolean }>;
  readonly logs: Array<{ modId: string; level: ModLogLevel; message: string }>;
  readonly clock: { now: number };
}

function makeSignIns(
  vault: ModSecretVault = makeMemoryModSecretVault(),
  fetchImpl?: ModOAuthFetch,
): Harness {
  const changes: Harness["changes"] = [];
  const logs: Harness["logs"] = [];
  const clock = { now: Date.parse("2026-10-10T10:00:00.000Z") };
  const signIns = new ModMcpSignIns({
    vault,
    port: 0,
    onChange: (modId, redraw) => changes.push({ modId, redraw }),
    log: (modId, level, message) => logs.push({ modId, level, message }),
    now: () => clock.now,
    fetch: fetchImpl,
  });
  stops.push(() => signIns.stop());
  return { signIns, vault, changes, logs, clock };
}

function clientFor(harness: Harness, config: RemoteConfig, modId = "prs"): ModMcpClient {
  const client = new ModMcpClient(
    "tracker",
    config,
    harness.signIns.access(modId, "tracker", config),
  );
  stops.push(() => client.close());
  return client;
}

async function signIn(harness: Harness, config: RemoteConfig, modId = "prs"): Promise<void> {
  const response = await finishInBrowser(await harness.signIns.begin(modId, "tracker", config));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Signed in");
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close();
});

describe("ModMcpSignIns", () => {
  it("notices a server that asks for a sign-in, with or without the usual refusal", async () => {
    for (const overrides of [{}, { refusal: 403 as const, challenge: false }]) {
      const server = await fakeServer(overrides);
      const harness = makeSignIns();
      const config: RemoteConfig = { url: server.url };
      const client = clientFor(harness, config);

      const failure = await client.callTool("list", {}).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ModMcpSignInNeededError);
      expect((failure as ModMcpSignInNeededError).code).toBe(MOD_MCP_SIGN_IN_NEEDED_CODE);
      expect(harness.signIns.summary("prs", { tracker: config })).toEqual([
        { server: "tracker", host: new URL(server.origin).host, state: "needed", detail: null },
      ]);
      expect(harness.changes).toEqual([{ modId: "prs", redraw: false }]);

      // Known to wait for a sign-in: the next call does not go to the server at all.
      const before = server.requests.length;
      await expect(client.callTool("list", {})).rejects.toBeInstanceOf(ModMcpSignInNeededError);
      expect(server.requests.length).toBe(before);
    }
  });

  it("leaves a server that refuses for another reason alone", async () => {
    const server = await fakeServer({ metadata: false, refusal: 403, challenge: false });
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };

    await expect(clientFor(harness, config).callTool("list", {})).rejects.toThrow(/HTTP 403/u);
    expect(harness.signIns.summary("prs", { tracker: config })).toEqual([]);
  });

  it("does not take a server that is asleep for one without sign-in", async () => {
    const server = await fakeServer({ refusal: 403, challenge: false });
    let asleep = true;
    const harness = makeSignIns(undefined, (url, init) =>
      asleep ? Promise.reject(new TypeError("fetch failed")) : fetch(url, init),
    );
    const config: RemoteConfig = { url: server.url };
    const client = clientFor(harness, config);

    await expect(client.callTool("list", {})).rejects.toThrow(/HTTP 403/u);
    expect(harness.signIns.summary("prs", { tracker: config })).toEqual([]);

    asleep = false;
    await expect(client.callTool("list", {})).rejects.toBeInstanceOf(ModMcpSignInNeededError);
  });

  it("signs in through the browser and then calls the server with the token", async () => {
    const server = await fakeServer();
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };
    const client = clientFor(harness, config);
    await expect(client.callTool("list", {})).rejects.toBeInstanceOf(ModMcpSignInNeededError);

    await signIn(harness, config);

    const asked = server.authorizations.at(-1)!;
    expect(asked.get("response_type")).toBe("code");
    expect(asked.get("code_challenge_method")).toBe("S256");
    expect(asked.get("resource")).toBe(server.url);
    expect(asked.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
    expect(server.registrations.at(-1)).toMatchObject({
      client_name: "Synara (prs mod)",
      redirect_uris: [asked.get("redirect_uri")],
      token_endpoint_auth_method: "none",
    });
    expect(harness.signIns.summary("prs", { tracker: config })).toEqual([
      { server: "tracker", host: new URL(server.origin).host, state: "signed-in", detail: null },
    ]);
    expect(harness.changes.at(-1)).toEqual({ modId: "prs", redraw: true });

    const result = await client.callTool("list", {});
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ answered: true }) }]);
    const [token] = [...server.tokens];
    expect(server.requests.at(-1)?.authorization).toBe(`Bearer ${token}`);
    // The token is in the vault and nowhere a mod or a window can read.
    expect(await harness.vault.read("prs")).toContain(token);
    expect(JSON.stringify([harness.logs, harness.changes])).not.toContain(token);
  });

  it("keeps a sign-in across a restart and for its own mod only", async () => {
    const server = await fakeServer();
    const config: RemoteConfig = { url: server.url };
    const first = makeSignIns();
    await signIn(first, config);

    const second = makeSignIns(first.vault);
    await second.signIns.load("prs");
    expect(second.signIns.summary("prs", { tracker: config })[0]?.state).toBe("signed-in");
    await expect(clientFor(second, config).callTool("list", {})).resolves.toMatchObject({
      isError: false,
    });

    // Another mod naming the same server has no sign-in of its own.
    await expect(clientFor(second, config, "other").callTool("list", {})).rejects.toBeInstanceOf(
      ModMcpSignInNeededError,
    );
  });

  it("names the client id a server that does not register apps needs", async () => {
    const server = await fakeServer({ registration: false });
    const harness = makeSignIns();

    await expect(harness.signIns.begin("prs", "tracker", { url: server.url })).rejects.toThrow(
      /does not register apps by itself.*"oauth": \{ "clientId".*http:\/\/127\.0\.0\.1:\d+\/callback/u,
    );

    // The agent writing the mod reads why in the mod's list entry and log.
    expect(harness.signIns.summary("prs", { tracker: { url: server.url } })[0]).toMatchObject({
      state: "needed",
      detail: expect.stringContaining("does not register apps by itself"),
    });
    expect(harness.logs.at(-1)?.message).toContain('The sign-in to "tracker" could not start');

    // The mod starts again with a corrected manifest: the old reason is not shown for it.
    harness.signIns.restarted("prs");
    const config: RemoteConfig = {
      url: server.url,
      oauth: { clientId: "known-client", scopes: ["prs.read"] },
    };
    expect(harness.signIns.summary("prs", { tracker: config })[0]?.detail).toBeNull();
    // Declared in the manifest: the sign-in is known to be needed before any call.
    expect(harness.signIns.summary("prs", { tracker: config })[0]?.state).toBe("needed");
    await signIn(harness, config);
    expect(server.authorizations.at(-1)?.get("client_id")).toBe("known-client");
    expect(server.authorizations.at(-1)?.get("scope")).toBe("prs.read");
    expect(server.registrations).toEqual([]);
  });

  it("will not sign in where a caught code could be traded by someone else", async () => {
    const server = await fakeServer({ pkce: false });
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };

    await expect(harness.signIns.begin("prs", "tracker", config)).rejects.toThrow(/PKCE/u);
    // A call finds the same, and the row says why there is no way to sign in.
    await expect(clientFor(harness, config).callTool("list", {})).rejects.toBeInstanceOf(
      ModMcpSignInNeededError,
    );
    expect(harness.signIns.summary("prs", { tracker: config })[0]?.detail).toMatch(/PKCE/u);
  });

  it("ignores a document that describes another address", async () => {
    const server = await fakeServer({ resource: "https://elsewhere.example/mcp" });
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };

    await signIn(harness, config);
    // The token is asked for the server the mod calls, not the one the document names.
    expect(server.authorizations.at(-1)?.get("resource")).toBe(server.url);
  });

  it("renews a token that ran out, and asks again when it cannot", async () => {
    const server = await fakeServer({ refresh: true, expiresIn: 60 });
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };
    const client = clientFor(harness, config);
    await signIn(harness, config);
    await client.callTool("list", {});
    const first = server.requests.at(-1)?.authorization;

    harness.clock.now += 120_000;
    await client.callTool("list", {});
    const second = server.requests.at(-1)?.authorization;
    expect(second).not.toBe(first);
    expect(second).toMatch(/^Bearer access-/u);

    // The server stops renewing: the next time the token runs out, the person is asked.
    server.options.refresh = false;
    harness.clock.now += 120_000;
    await client.callTool("list", {});
    harness.clock.now += 120_000;
    await expect(client.callTool("list", {})).rejects.toBeInstanceOf(ModMcpSignInNeededError);
    expect(harness.signIns.summary("prs", { tracker: config })).toEqual([
      {
        server: "tracker",
        host: new URL(server.origin).host,
        state: "needed",
        detail: "The sign-in ran out.",
      },
    ]);
    expect(await harness.vault.read("prs")).toBeNull();
  });

  it("asks again when the server stops accepting the token", async () => {
    const server = await fakeServer({ expiresIn: null });
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };
    const client = clientFor(harness, config);
    await signIn(harness, config);
    await client.callTool("list", {});

    server.tokens.clear();
    await expect(client.callTool("list", {})).rejects.toBeInstanceOf(ModMcpSignInNeededError);
    expect(harness.signIns.summary("prs", { tracker: config })[0]).toMatchObject({
      state: "needed",
      detail: "The server no longer accepts the sign-in.",
    });
  });

  it("sends a token only to the address it was made for", async () => {
    const server = await fakeServer();
    const other = await fakeServer();
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };
    await signIn(harness, config);

    // The mod's manifest now names another server under the same name.
    const moved: RemoteConfig = { url: other.url };
    await expect(clientFor(harness, moved).callTool("list", {})).rejects.toBeInstanceOf(
      ModMcpSignInNeededError,
    );
    expect(other.requests.some((request) => request.authorization !== null)).toBe(false);
    expect(await harness.vault.read("prs")).toBeNull();

    // A server that sends requests on to another origin does not take the token along.
    const again = makeSignIns();
    await signIn(again, config);
    server.options.redirectTo = other.url;
    await clientFor(again, config)
      .callTool("list", {})
      .catch(() => undefined);
    expect(server.tokens.size).toBe(2);
    // The request did arrive there (the first one is the moved mod's own).
    expect(other.requests.filter((request) => request.path === "/mcp").length).toBeGreaterThan(1);
    expect(other.requests.some((request) => request.authorization !== null)).toBe(false);
  });

  it("opens one sign-in once per page, and only for the page it opened", async () => {
    const server = await fakeServer();
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };

    const url = await harness.signIns.begin("prs", "tracker", config);
    const page = await fetch(url, { redirect: "manual" });
    const back = new URL(page.headers.get("location") ?? "");

    const forged = new URL(back);
    forged.searchParams.set("state", "guessed");
    expect((await fetch(forged)).status).toBe(400);
    const elsewhere = new URL(back);
    elsewhere.pathname = "/other";
    expect((await fetch(elsewhere)).status).toBe(404);

    expect((await fetch(back)).status).toBe(200);
    // The same page again: its state was used.
    expect((await fetch(back).catch(() => ({ status: 0 }))).status).not.toBe(200);
    expect(server.tokens.size).toBe(1);
  });

  it("reports a sign-in the person or the server did not complete", async () => {
    const server = await fakeServer();
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };

    const url = await harness.signIns.begin("prs", "tracker", config);
    const page = await fetch(url, { redirect: "manual" });
    const back = new URL(page.headers.get("location") ?? "");
    back.searchParams.delete("code");
    back.searchParams.set("error", "access_denied");
    const response = await fetch(back);

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("access_denied");
    expect(harness.signIns.summary("prs", { tracker: config })[0]).toMatchObject({
      state: "needed",
      detail: expect.stringContaining("access_denied"),
    });
    expect(harness.logs.at(-1)).toMatchObject({ modId: "prs", level: "error" });
  });

  it("signs out, and forgets a mod's sign-ins with the mod", async () => {
    const server = await fakeServer();
    const harness = makeSignIns();
    const config: RemoteConfig = { url: server.url };
    const client = clientFor(harness, config);
    await signIn(harness, config);

    await harness.signIns.signOut("prs", "tracker");
    expect(await harness.vault.read("prs")).toBeNull();
    expect(harness.signIns.summary("prs", { tracker: config })[0]?.state).toBe("needed");
    await expect(client.callTool("list", {})).rejects.toBeInstanceOf(ModMcpSignInNeededError);

    await signIn(harness, config);
    // A sign-in under way when the mod goes away is not kept for a later mod of that name.
    const url = await harness.signIns.begin("prs", "tracker", config);
    await harness.signIns.forget("prs");
    const status = await finishInBrowser(url).then(
      (response) => response.status,
      () => 0,
    );
    expect(status).not.toBe(200);
    expect(await harness.vault.read("prs")).toBeNull();
    expect(harness.signIns.summary("prs", { tracker: config })).toEqual([]);
  });

  it("leaves a server alone when the manifest sends its own Authorization header", () => {
    const harness = makeSignIns();
    expect(
      harness.signIns.access("prs", "tracker", {
        url: "https://tracker.example/mcp",
        headers: { Authorization: "Bearer ${env:TRACKER_TOKEN}" },
      }),
    ).toBeNull();
    expect(
      harness.signIns.access("prs", "tracker", { url: "http://tracker.example/mcp" }),
    ).toBeNull();
  });
});

describe("ModManager sign-ins", () => {
  let root: string;
  let manager: ModManager;
  const events: ModsStreamEvent[] = [];

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "synara-mod-sign-in-"));
    events.length = 0;
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function writeMod(serverUrl: string): Promise<void> {
    const modRoot = path.join(root, "mods", "prs");
    await mkdir(path.join(modRoot, ".synara-mod"), { recursive: true });
    await mkdir(path.join(modRoot, "hooks"), { recursive: true });
    await writeFile(
      path.join(modRoot, ".synara-mod", "mod.json"),
      JSON.stringify({
        name: "prs",
        version: "0.1.0",
        mcpServers: { tracker: { url: serverUrl } },
      }),
    );
    await writeFile(
      path.join(modRoot, "hooks", "hooks.json"),
      JSON.stringify({ modules: ["./register.ts"] }),
    );
    await writeFile(
      path.join(modRoot, "hooks", "register.ts"),
      `export const register = (on) => {
        on("mod.start", async ($) => {
          await $.command.register({ name: "ask", title: "Ask" });
        });
        on("command.run", { command: "ask" }, async ($) => {
          const before = await $.mcp.status("tracker");
          try {
            const answer = await $.mcp.json("tracker", "list");
            return { text: JSON.stringify({ before, answer }) };
          } catch (error) {
            return { text: JSON.stringify({ before, code: error.code ?? null, after: await $.mcp.status("tracker") }) };
          }
        });
      };`,
    );
  }

  const ask = async () =>
    JSON.parse((await manager.runCommand("prs", "ask", null)).text ?? "null") as Record<
      string,
      unknown
    >;

  it("tells the mod, the windows and the person, and draws again after the sign-in", async () => {
    const server = await fakeServer();
    await writeMod(server.url);
    manager = new ModManager({
      modsDir: path.join(root, "mods"),
      dataDir: path.join(root, "data"),
      watch: false,
      signInPort: 0,
      backend: { listThreads: async () => [], listProjects: async () => [], log: () => undefined },
    });
    await manager.start();
    manager.subscribe((event) => events.push(event));

    // A sign-in is for a mod the person turned on.
    await expect(manager.beginMcpSignIn("prs", "tracker")).rejects.toThrow(
      /Turn the "prs" mod on/u,
    );
    await manager.setEnabled("prs", true);
    await manager.whenIdle();

    expect(await ask()).toEqual({
      before: "ready",
      code: MOD_MCP_SIGN_IN_NEEDED_CODE,
      after: "sign-in-needed",
    });
    const host = new URL(server.origin).host;
    expect(manager.snapshot().mods[0]?.mcpSignIns).toEqual([
      { server: "tracker", host, state: "needed", detail: null },
    ]);
    await expect(manager.beginMcpSignIn("prs", "nope")).rejects.toThrow(/not one of this mod's/u);

    const { url } = await manager.beginMcpSignIn("prs", "tracker");
    events.length = 0;
    expect((await finishInBrowser(url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(events).toContainEqual({ type: "invalidate", modId: "prs", viewId: null });
    expect(manager.snapshot().mods[0]?.mcpSignIns).toEqual([
      { server: "tracker", host, state: "signed-in", detail: null },
    ]);
    expect(await ask()).toEqual({ before: "ready", answer: { answered: true } });
    expect((await manager.readLogs("prs")).logs.at(-1)?.message).toContain("Signed in to");

    const snapshot = await manager.signOutMcp("prs", "tracker");
    expect(snapshot.mods[0]?.mcpSignIns[0]?.state).toBe("needed");
    expect(await ask()).toMatchObject({
      before: "sign-in-needed",
      code: MOD_MCP_SIGN_IN_NEEDED_CODE,
    });
  });
});

it("reuses the resource_metadata challenge when starting sign-in", async () => {
  const server = await fakeServer();
  const custom = `${server.origin}/advertised-metadata`;
  const harness = makeSignIns(undefined, async (url, init) => {
    if (String(url) === custom)
      return Response.json({
        resource: server.url,
        authorization_servers: [`${server.origin}/tenant`],
      });
    if (String(url) === `${server.origin}/.well-known/oauth-authorization-server/tenant`) {
      const doc = (await (
        await fetch(`${server.origin}/.well-known/oauth-authorization-server`, init)
      ).json()) as Record<string, unknown>;
      return Response.json({ ...doc, issuer: `${server.origin}/tenant` });
    }
    if (String(url) === `${server.origin}/.well-known/oauth-authorization-server`)
      return new Response("{}", { status: 404 });
    if (String(url).includes("/.well-known/oauth-protected-resource"))
      return new Response("{}", { status: 404 });
    return fetch(url, init);
  });
  const config = { url: server.url, oauth: { clientId: "known-client" } };
  await expect(
    harness.signIns
      .access("prs", "tracker", config)!
      .refused({ status: 401, token: null, challenge: `Bearer resource_metadata="${custom}"` }),
  ).rejects.toBeInstanceOf(ModMcpSignInNeededError);
  await signIn(harness, config);
});
it.each(["sign-out", "forget", "stop", "replace"])(
  "rejects a sign-in prepared before %s during discovery",
  async (change) => {
    const server = await fakeServer();
    let release = () => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const harness = makeSignIns(undefined, async (url, init) => {
      if (first && String(url).includes("oauth-protected-resource")) {
        first = false;
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return fetch(url, init);
    });
    const config = { url: server.url, oauth: { clientId: "known-client" } };
    const old = harness.signIns.begin("prs", "tracker", config).catch((error: unknown) => error);
    await waiting;
    if (change === "sign-out") await harness.signIns.signOut("prs", "tracker");
    else if (change === "forget") await harness.signIns.forget("prs");
    else if (change === "stop") await harness.signIns.stop();
    else await harness.signIns.begin("prs", "tracker", config);
    release();
    expect(await old).toBeInstanceOf(Error);
  },
);
it.each(["sign-out", "replace", "stop"])(
  "does not keep an OAuth exchange completed after %s",
  async (change) => {
    const server = await fakeServer();
    let release = () => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const harness = makeSignIns(undefined, async (url, init) => {
      if (String(url) === `${server.origin}/token`) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return fetch(url, init);
    });
    const config = { url: server.url, oauth: { clientId: "known-client" } };
    const page = await harness.signIns.begin("prs", "tracker", config);
    const returned = finishInBrowser(page);
    await waiting;
    if (change === "sign-out") await harness.signIns.signOut("prs", "tracker");
    else if (change === "stop") await harness.signIns.stop();
    else await harness.signIns.begin("prs", "tracker", config);
    release();
    expect((await returned).status).toBe(400);
    expect(harness.signIns.summary("prs", { tracker: config })[0]?.state).toBe("needed");
    expect(await harness.vault.read("prs")).toBeNull();
  },
);
