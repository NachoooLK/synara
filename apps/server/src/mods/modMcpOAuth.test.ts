// FILE: modMcpOAuth.test.ts
// Purpose: The checks Synara makes on what a mod's MCP server and its
//          authorization server say about signing in, against answers a hostile
//          or sloppy server could give.
// Layer: Mods runtime tests

import { describe, expect, it } from "vitest";

import {
  buildModMcpAuthorizationUrl,
  canSignInTo,
  createModMcpPkce,
  discoverModMcpAuthorization,
  exchangeModMcpCode,
  type ModMcpAuthorization,
  type ModOAuthFetch,
  resolveModMcpClient,
  resourceMetadataFromChallenge,
} from "./modMcpOAuth.ts";

/** Answers each address with the JSON given for it, and 404 for the rest. */
function fakeFetch(documents: Record<string, unknown>): ModOAuthFetch & { asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    return Object.hasOwn(documents, url)
      ? new Response(JSON.stringify(documents[url]), { status: 200 })
      : new Response("Not found", { status: 404 });
  };
  return Object.assign(fetchImpl, { asked });
}

const AUTHORIZATION_SERVER = {
  issuer: "https://login.example",
  authorization_endpoint: "https://login.example/authorize",
  token_endpoint: "https://login.example/token",
  code_challenge_methods_supported: ["S256"],
};

const AUTHORIZATION: ModMcpAuthorization = {
  resource: "https://tracker.example/mcp",
  issuer: "https://login.example",
  authorizationEndpoint: "https://login.example/authorize",
  tokenEndpoint: "https://login.example/token",
  registrationEndpoint: null,
  acceptsClientDocument: false,
  scopes: ["read"],
  sendsIssuer: false,
};

describe("discoverModMcpAuthorization", () => {
  it("follows the server's document to its authorization server", async () => {
    const fetchImpl = fakeFetch({
      "https://tracker.example/.well-known/oauth-protected-resource/mcp": {
        resource: "https://tracker.example/mcp",
        authorization_servers: ["https://login.example"],
        scopes_supported: ["read", "write"],
      },
      "https://login.example/.well-known/oauth-authorization-server": {
        ...AUTHORIZATION_SERVER,
        registration_endpoint: "https://login.example/register",
        client_id_metadata_document_supported: true,
      },
    });

    await expect(
      discoverModMcpAuthorization({
        serverUrl: "https://tracker.example/mcp#part",
        challenge: null,
        fetch: fetchImpl,
      }),
    ).resolves.toEqual({
      resource: "https://tracker.example/mcp",
      issuer: "https://login.example",
      authorizationEndpoint: "https://login.example/authorize",
      tokenEndpoint: "https://login.example/token",
      registrationEndpoint: "https://login.example/register",
      acceptsClientDocument: true,
      scopes: ["read", "write"],
      sendsIssuer: false,
    });
  });

  it("finds an authorization server that lives under a path, and an OpenID one", async () => {
    const fetchImpl = fakeFetch({
      "https://tracker.example/.well-known/oauth-protected-resource": {
        resource: "https://tracker.example",
        authorization_servers: ["https://login.example/tenant"],
      },
      "https://login.example/tenant/.well-known/openid-configuration": {
        ...AUTHORIZATION_SERVER,
        issuer: "https://login.example/tenant",
      },
    });

    const found = await discoverModMcpAuthorization({
      serverUrl: "https://tracker.example/mcp",
      challenge: null,
      fetch: fetchImpl,
    });
    expect(found?.issuer).toBe("https://login.example/tenant");
    // The document describes the whole origin, which the mod's server is part of.
    expect(found?.resource).toBe("https://tracker.example/");
  });

  it("says nothing of a server that publishes nothing", async () => {
    await expect(
      discoverModMcpAuthorization({
        serverUrl: "https://tracker.example/mcp",
        challenge: null,
        fetch: fakeFetch({}),
      }),
    ).resolves.toBeNull();
  });

  it("refuses a sign-in that would leave https", async () => {
    const insecure = (overrides: Record<string, unknown>) =>
      discoverModMcpAuthorization({
        serverUrl: "https://tracker.example/mcp",
        challenge: null,
        fetch: fakeFetch({
          "https://tracker.example/.well-known/oauth-protected-resource/mcp": {
            resource: "https://tracker.example/mcp",
            authorization_servers: ["https://login.example"],
            ...overrides,
          },
          "https://login.example/.well-known/oauth-authorization-server": {
            ...AUTHORIZATION_SERVER,
            token_endpoint: "http://login.example/token",
          },
        }),
      });

    await expect(insecure({})).rejects.toThrow(/https addresses/u);
    await expect(insecure({ authorization_servers: ["http://login.example"] })).rejects.toThrow(
      /not an https address/u,
    );
    // Plain http on this computer is for a server that is itself on this computer.
    await expect(insecure({ authorization_servers: ["http://127.0.0.1:9"] })).rejects.toThrow(
      /not an https address/u,
    );
  });

  it("does not take one server's word for another", async () => {
    // The document claims to describe another origin; the issuer's document names another issuer.
    const fetchImpl = fakeFetch({
      "https://tracker.example/.well-known/oauth-protected-resource/mcp": {
        resource: "https://bank.example/mcp",
        authorization_servers: ["https://login.example"],
      },
      "https://tracker.example/.well-known/oauth-protected-resource": {
        resource: "https://tracker.example/mcp",
        authorization_servers: ["https://login.example"],
      },
      "https://login.example/.well-known/oauth-authorization-server": {
        ...AUTHORIZATION_SERVER,
        issuer: "https://other.example",
      },
    });

    await expect(
      discoverModMcpAuthorization({
        serverUrl: "https://tracker.example/mcp",
        challenge: null,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/login\.example does not say how/u);
  });

  it("reads where the sign-in is described from the refusal", async () => {
    expect(
      resourceMetadataFromChallenge(
        'Bearer realm="mcp", resource_metadata="https://tracker.example/meta", error="invalid_token"',
      ),
    ).toBe("https://tracker.example/meta");
    expect(resourceMetadataFromChallenge("Bearer")).toBeNull();
    expect(resourceMetadataFromChallenge(null)).toBeNull();

    const fetchImpl = fakeFetch({
      "https://tracker.example/meta": {
        resource: "https://tracker.example/mcp",
        authorization_servers: ["https://login.example"],
      },
      "https://login.example/.well-known/oauth-authorization-server": AUTHORIZATION_SERVER,
    });
    const found = await discoverModMcpAuthorization({
      serverUrl: "https://tracker.example/mcp",
      challenge: 'Bearer resource_metadata="https://tracker.example/meta"',
      fetch: fetchImpl,
    });
    expect(found?.issuer).toBe("https://login.example");
    expect(fetchImpl.asked[0]).toBe("https://tracker.example/meta");
  });
});

describe("the sign-in itself", () => {
  it("asks for a token only this server accepts, bound to a secret that stays here", () => {
    const pkce = createModMcpPkce();
    const url = new URL(
      buildModMcpAuthorizationUrl({
        authorization: AUTHORIZATION,
        client: { clientId: "https://synara.example/client.json", clientSecret: null },
        redirectUri: "http://127.0.0.1:47823/callback",
        state: "state-1",
        challenge: pkce.challenge,
        scopes: undefined,
      }),
    );

    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "https://synara.example/client.json",
      redirect_uri: "http://127.0.0.1:47823/callback",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: "state-1",
      resource: "https://tracker.example/mcp",
      scope: "read",
    });
    expect(url.href).not.toContain(pkce.verifier);
  });

  it("explains what to add when the server does not register apps", async () => {
    await expect(
      resolveModMcpClient({
        authorization: { ...AUTHORIZATION, acceptsClientDocument: true },
        config: undefined,
        redirectUri: "http://127.0.0.1:47823/callback",
        modId: "prs",
        fetch: fakeFetch({}),
      }),
    ).rejects.toThrow(/client metadata document/u);
  });

  it("takes only a token it can send as a bearer", async () => {
    const exchange = (answer: Record<string, unknown>, status = 200) =>
      exchangeModMcpCode({
        authorization: AUTHORIZATION,
        client: { clientId: "client", clientSecret: null },
        redirectUri: "http://127.0.0.1:47823/callback",
        code: "code",
        verifier: "verifier",
        now: 1_000,
        fetch: async () => new Response(JSON.stringify(answer), { status }),
      });

    await expect(
      exchange({ access_token: "abc", token_type: "bearer", expires_in: 60, refresh_token: "r" }),
    ).resolves.toEqual({ accessToken: "abc", refreshToken: "r", expiresAt: 61_000, scope: null });
    await expect(exchange({ access_token: "abc", token_type: "DPoP" })).rejects.toThrow(
      /without a token Synara can use/u,
    );
    // A token with a line break would add a header to every request that carries it.
    await expect(exchange({ access_token: "abc\r\nx-evil: 1" })).rejects.toThrow(
      /without a token Synara can use/u,
    );
    await expect(
      exchange({ error: "invalid_grant", error_description: "Too\nlate" }, 400),
    ).rejects.toThrow("login.example did not give a token (Too late).");
  });

  it("offers sign-in for https servers and servers on this computer", () => {
    expect(canSignInTo("https://tracker.example/mcp")).toBe(true);
    expect(canSignInTo("http://127.0.0.1:8080/mcp")).toBe(true);
    expect(canSignInTo("http://tracker.example/mcp")).toBe(false);
    expect(canSignInTo("ftp://tracker.example")).toBe(false);
  });
});
