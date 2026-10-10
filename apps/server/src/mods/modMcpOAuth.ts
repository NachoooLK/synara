// FILE: modMcpOAuth.ts
// Purpose: The OAuth steps behind signing a person in to a mod's remote MCP
//          server: finding the authorization server the MCP server names,
//          naming Synara as the client, building the sign-in page address and
//          trading the returned code (or a refresh token) for an access token.
//          Every answer read here comes from a server the mod chose, so each one
//          is size-capped, time-boxed and checked before it is used.
// Layer: Mods runtime

import { createHash, randomBytes } from "node:crypto";

import type { ModMcpOAuthConfig } from "@synara/contracts";

/** Long enough for a server that was asleep to wake up and answer. */
const OAUTH_DOCUMENT_TIMEOUT_MS = 10_000;
/** Registering and trading a code may reach a database on the other side. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const OAUTH_ANSWER_BYTES = 256 * 1024;
const OAUTH_ERROR_TEXT_LIMIT = 300;
const OAUTH_TOKEN_CHARS_LIMIT = 16_384;

export type ModOAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What went wrong, in words the person and the agent writing the mod can act on. */
export class ModMcpOAuthError extends Error {
  override readonly name = "ModMcpOAuthError";
}

/** A server did not answer at all, which says nothing about how it signs people in. */
export class ModMcpOAuthUnreachableError extends ModMcpOAuthError {}

/** How a server signs people in, as its own documents describe it. */
export interface ModMcpAuthorization {
  /** The address tokens are asked for: the MCP server as its documents name it. */
  readonly resource: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** Where Synara can register itself as a client, when the server lets apps do that. */
  readonly registrationEndpoint: string | null;
  /** Whether a client id may be the address of a client metadata document. */
  readonly acceptsClientDocument: boolean;
  /** The scopes the MCP server lists for itself. */
  readonly scopes: ReadonlyArray<string>;
  /** Whether the authorization server names itself in what it sends back to the browser. */
  readonly sendsIssuer: boolean;
}

export interface ModMcpClientIdentity {
  readonly clientId: string;
  /** Only for a server that insists on giving a registered app a secret. */
  readonly clientSecret: string | null;
}

export interface ModMcpTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch milliseconds, when the server said how long the token lasts. */
  readonly expiresAt: number | null;
  readonly scope: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clamp(value: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters could forge lines in the mod's log
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return clean.length <= OAUTH_ERROR_TEXT_LIMIT
    ? clean
    : `${clean.slice(0, OAUTH_ERROR_TEXT_LIMIT - 1)}…`;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/**
 * Sign-in traffic is https. Plain http is accepted only on this computer, and
 * only for a server that is itself on this computer (a server being developed).
 */
function isAllowedEndpoint(url: URL, resource: URL): boolean {
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" && isLoopbackHost(url.hostname) && isLoopbackHost(resource.hostname)
  );
}

/** The MCP server's address as a token is asked for it: no fragment, no credentials. */
export function modMcpResourceOf(serverUrl: string): URL {
  const url = parseUrl(serverUrl);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new ModMcpOAuthError("The server's URL must be http or https.");
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  return url;
}

/** Whether a mod's server may use sign-in at all: https, or a server on this computer. */
export function canSignInTo(serverUrl: string): boolean {
  try {
    const url = modMcpResourceOf(serverUrl);
    return url.protocol === "https:" || isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > OAUTH_ANSWER_BYTES) throw new ModMcpOAuthError("The answer was too large.");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

interface JsonAnswer {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

async function requestJson(
  fetchImpl: ModOAuthFetch,
  url: string,
  init: RequestInit,
): Promise<JsonAnswer> {
  const abort = new AbortController();
  const timeoutMs = init.method === "POST" ? OAUTH_REQUEST_TIMEOUT_MS : OAUTH_DOCUMENT_TIMEOUT_MS;
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: { accept: "application/json", ...(init.headers as Record<string, string>) },
      // A POST carries a code or a refresh token: it goes to the address asked, or nowhere.
      redirect: init.method === "POST" ? "error" : "follow",
      signal: abort.signal,
    });
    const text = await readCapped(response);
    let body: Record<string, unknown> | null = null;
    try {
      body = asRecord(JSON.parse(text));
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof ModMcpOAuthError) throw error;
    throw new ModMcpOAuthUnreachableError(
      abort.signal.aborted
        ? `${new URL(url).host} did not answer within ${timeoutMs / 1_000} s.`
        : `${new URL(url).host} cannot be reached.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function getDocument(
  fetchImpl: ModOAuthFetch,
  url: string,
): Promise<Record<string, unknown> | null> {
  const answer = await requestJson(fetchImpl, url, { method: "GET" }).catch((error: unknown) => {
    // Silence is not "no": the caller must not conclude the server has no sign-in.
    if (error instanceof ModMcpOAuthUnreachableError) throw error;
    return null;
  });
  return answer !== null && answer.status >= 200 && answer.status < 300 ? answer.body : null;
}

/** The `resource_metadata` address a `WWW-Authenticate` header points at, if any. */
export function resourceMetadataFromChallenge(challenge: string | null): string | null {
  if (challenge === null) return null;
  const match = /resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,]+))/iu.exec(challenge);
  return match?.[1] ?? match?.[2] ?? null;
}

function wellKnown(base: URL, name: string): string[] {
  const path = base.pathname.replace(/\/+$/u, "");
  const root = `${base.origin}/.well-known/${name}`;
  return path.length > 0 ? [`${root}${path}`, root] : [root];
}

/**
 * Whether a document that says it describes `named` describes the server at
 * `actual`: same origin, and the server's path at or under the named one. A
 * document naming another address would have Synara ask for a token meant for
 * a server the mod does not call.
 */
function describes(named: URL, actual: URL): boolean {
  if (named.origin !== actual.origin) return false;
  const namedPath = named.pathname.replace(/\/+$/u, "");
  const actualPath = actual.pathname.replace(/\/+$/u, "");
  return actualPath === namedPath || actualPath.startsWith(`${namedPath}/`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

async function findAuthorizationServer(
  fetchImpl: ModOAuthFetch,
  issuer: URL,
  resource: URL,
): Promise<Record<string, unknown> | null> {
  const path = issuer.pathname.replace(/\/+$/u, "");
  const candidates =
    path.length > 0
      ? [
          `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
          `${issuer.origin}/.well-known/openid-configuration${path}`,
          `${issuer.origin}${path}/.well-known/openid-configuration`,
        ]
      : [
          `${issuer.origin}/.well-known/oauth-authorization-server`,
          `${issuer.origin}/.well-known/openid-configuration`,
        ];
  for (const candidate of candidates) {
    const url = parseUrl(candidate);
    if (url === null || !isAllowedEndpoint(url, resource)) continue;
    const document = await getDocument(fetchImpl, candidate);
    if (document === null) continue;
    // A document that names another issuer describes another server.
    const named = parseUrl(document.issuer);
    if (named === null || named.href.replace(/\/+$/u, "") !== issuer.href.replace(/\/+$/u, "")) {
      continue;
    }
    return document;
  }
  return null;
}

/**
 * Reads how the server at `serverUrl` signs people in. Null when the server
 * publishes nothing about it, which means it does not ask for sign-in this way.
 * Throws when it does ask but in a way Synara will not follow, and
 * `ModMcpOAuthUnreachableError` when a server it had to ask did not answer.
 */
export async function discoverModMcpAuthorization(input: {
  readonly serverUrl: string;
  /** The `WWW-Authenticate` header of the refused request, when there was one. */
  readonly challenge: string | null;
  readonly fetch?: ModOAuthFetch | undefined;
}): Promise<ModMcpAuthorization | null> {
  const fetchImpl = input.fetch ?? fetch;
  const server = modMcpResourceOf(input.serverUrl);
  const hinted = parseUrl(resourceMetadataFromChallenge(input.challenge));
  const candidates = [
    ...(hinted !== null && isAllowedEndpoint(hinted, server) ? [hinted.href] : []),
    ...wellKnown(server, "oauth-protected-resource"),
  ];
  let resource = server;
  let issuer: URL | null = null;
  let scopes: string[] = [];
  for (const candidate of new Set(candidates)) {
    const document = await getDocument(fetchImpl, candidate);
    if (document === null) continue;
    const named = parseUrl(document.resource);
    if (named === null || !describes(named, server)) continue;
    const first = parseUrl(stringList(document.authorization_servers)[0]);
    if (first === null) continue;
    named.hash = "";
    resource = named;
    issuer = first;
    scopes = stringList(document.scopes_supported);
    break;
  }
  const serverNamesIssuer = issuer !== null;
  // Servers from before that document describe their sign-in at their own origin.
  issuer ??= new URL(server.origin);
  if (!isAllowedEndpoint(issuer, server)) {
    throw new ModMcpOAuthError(
      `The server's sign-in is at ${issuer.host}, which is not an https address.`,
    );
  }
  const document = await findAuthorizationServer(fetchImpl, issuer, server);
  if (document === null) {
    if (!serverNamesIssuer) return null;
    throw new ModMcpOAuthError(
      `The server sends people to ${issuer.host} to sign in, but ${issuer.host} does not say how.`,
    );
  }
  const authorizationEndpoint = parseUrl(document.authorization_endpoint);
  const tokenEndpoint = parseUrl(document.token_endpoint);
  if (
    authorizationEndpoint === null ||
    tokenEndpoint === null ||
    !isAllowedEndpoint(authorizationEndpoint, server) ||
    !isAllowedEndpoint(tokenEndpoint, server)
  ) {
    throw new ModMcpOAuthError(
      `${issuer.host} does not give https addresses to sign in and to get a token.`,
    );
  }
  // Without PKCE a code caught on its way back could be traded by someone else.
  if (!stringList(document.code_challenge_methods_supported).includes("S256")) {
    throw new ModMcpOAuthError(
      `${issuer.host} does not protect the sign-in with PKCE (S256), so Synara will not use it.`,
    );
  }
  const responseTypes = stringList(document.response_types_supported);
  if (responseTypes.length > 0 && !responseTypes.includes("code")) {
    throw new ModMcpOAuthError(`${issuer.host} does not offer the sign-in Synara uses (code).`);
  }
  const registrationEndpoint = parseUrl(document.registration_endpoint);
  return {
    resource: resource.href,
    issuer: issuer.href.replace(/\/+$/u, ""),
    authorizationEndpoint: authorizationEndpoint.href,
    tokenEndpoint: tokenEndpoint.href,
    registrationEndpoint:
      registrationEndpoint !== null && isAllowedEndpoint(registrationEndpoint, server)
        ? registrationEndpoint.href
        : null,
    acceptsClientDocument: document.client_id_metadata_document_supported === true,
    scopes,
    sendsIssuer: document.authorization_response_iss_parameter_supported === true,
  };
}

function describeRefusal(answer: JsonAnswer): string {
  const description = textOf(answer.body?.error_description) ?? textOf(answer.body?.error);
  return description === null ? `HTTP ${answer.status}` : clamp(description);
}

/**
 * Who Synara says it is to the authorization server: the client id the mod's
 * manifest gives, or one the server hands out when it registers apps itself.
 */
export async function resolveModMcpClient(input: {
  readonly authorization: ModMcpAuthorization;
  readonly config: ModMcpOAuthConfig | undefined;
  readonly redirectUri: string;
  readonly modId: string;
  readonly fetch?: ModOAuthFetch | undefined;
}): Promise<ModMcpClientIdentity> {
  const declared = input.config?.clientId;
  if (declared !== undefined) return { clientId: declared, clientSecret: null };
  const { authorization } = input;
  const host = new URL(authorization.issuer).host;
  if (authorization.registrationEndpoint === null) {
    throw new ModMcpOAuthError(
      `${host} does not register apps by itself, so the mod has to name one: add "oauth": { "clientId": "…" } to this server in mod.json, with a client id registered for the return address ${input.redirectUri}.${
        authorization.acceptsClientDocument
          ? " This server accepts a client id that is the https address of a client metadata document listing that return address."
          : ""
      }`,
    );
  }
  const answer = await requestJson(input.fetch ?? fetch, authorization.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `Synara (${input.modId} mod)`,
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = textOf(answer.body?.client_id);
  if (answer.status < 200 || answer.status >= 300 || clientId === null) {
    throw new ModMcpOAuthError(
      `${host} would not register Synara as an app (${describeRefusal(answer)}).`,
    );
  }
  return { clientId, clientSecret: textOf(answer.body?.client_secret) };
}

export interface ModMcpPkce {
  readonly verifier: string;
  readonly challenge: string;
}

export function createModMcpPkce(): ModMcpPkce {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function createModMcpState(): string {
  return randomBytes(32).toString("base64url");
}

/** The page the person signs in on. */
export function buildModMcpAuthorizationUrl(input: {
  readonly authorization: ModMcpAuthorization;
  readonly client: ModMcpClientIdentity;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  readonly scopes: ReadonlyArray<string> | undefined;
}): string {
  const url = new URL(input.authorization.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  // Asks for a token that only this MCP server accepts.
  url.searchParams.set("resource", input.authorization.resource);
  const scopes = input.scopes ?? input.authorization.scopes;
  if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
  return url.href;
}

async function requestTokens(
  fetchImpl: ModOAuthFetch,
  authorization: Pick<ModMcpAuthorization, "tokenEndpoint" | "issuer">,
  parameters: Record<string, string>,
  now: number,
): Promise<ModMcpTokens> {
  const host = new URL(authorization.issuer).host;
  const answer = await requestJson(fetchImpl, authorization.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters).toString(),
  });
  if (answer.status < 200 || answer.status >= 300 || answer.body === null) {
    throw new ModMcpOAuthError(`${host} did not give a token (${describeRefusal(answer)}).`);
  }
  const accessToken = textOf(answer.body.access_token);
  const tokenType = textOf(answer.body.token_type);
  if (
    accessToken === null ||
    accessToken.length > OAUTH_TOKEN_CHARS_LIMIT ||
    // A token that is not sent as a bearer (DPoP, MAC) needs proof Synara does not make.
    (tokenType !== null && tokenType.toLowerCase() !== "bearer") ||
    // The token travels in a header: anything outside its alphabet could add one.
    !/^[\x21-\x7e]+$/u.test(accessToken)
  ) {
    throw new ModMcpOAuthError(`${host} answered without a token Synara can use.`);
  }
  const refreshToken = textOf(answer.body.refresh_token);
  const expiresIn = Number(answer.body.expires_in);
  return {
    accessToken,
    refreshToken:
      refreshToken !== null && refreshToken.length <= OAUTH_TOKEN_CHARS_LIMIT ? refreshToken : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1_000 : null,
    scope: textOf(answer.body.scope),
  };
}

/** Trades the code the browser came back with for a token. */
export function exchangeModMcpCode(input: {
  readonly authorization: Pick<ModMcpAuthorization, "tokenEndpoint" | "issuer" | "resource">;
  readonly client: ModMcpClientIdentity;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
  readonly fetch?: ModOAuthFetch | undefined;
  readonly now?: number | undefined;
}): Promise<ModMcpTokens> {
  return requestTokens(
    input.fetch ?? fetch,
    input.authorization,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.client.clientId,
      code_verifier: input.verifier,
      resource: input.authorization.resource,
      ...(input.client.clientSecret === null ? {} : { client_secret: input.client.clientSecret }),
    },
    input.now ?? Date.now(),
  );
}

/** Gets a new token with the refresh token of one that ran out. */
export function refreshModMcpTokens(input: {
  readonly authorization: Pick<ModMcpAuthorization, "tokenEndpoint" | "issuer" | "resource">;
  readonly client: ModMcpClientIdentity;
  readonly refreshToken: string;
  readonly fetch?: ModOAuthFetch | undefined;
  readonly now?: number | undefined;
}): Promise<ModMcpTokens> {
  return requestTokens(
    input.fetch ?? fetch,
    input.authorization,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.client.clientId,
      resource: input.authorization.resource,
      ...(input.client.clientSecret === null ? {} : { client_secret: input.client.clientSecret }),
    },
    input.now ?? Date.now(),
  );
}
