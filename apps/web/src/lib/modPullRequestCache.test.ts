import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { ModsSnapshot } from "@synara/contracts";
import { expect, it } from "vitest";
import { reconcileModPullRequestCache, invalidateModPullRequestCache } from "./modPullRequestCache";
function snapshot(revision: string) {
  return Schema.decodeUnknownSync(ModsSnapshot)({
    modsDir: "/mods",
    mods: [
      {
        id: "demo",
        version: "1",
        path: "/mods/demo",
        enabled: true,
        status: "running",
        error: null,
        description: null,
        hooks: [],
        commands: [],
        tools: [],
        views: [],
        mcpServers: [],
        mcpSignIns: [],
        permissions: [],
        reloadsOnChange: false,
        statusText: null,
        loadedAt: null,
        pullRequestSources: [
          {
            source: { kind: "mod", modId: "demo", sourceId: "reviews" },
            title: "Reviews",
            capabilities: {},
            revision,
          },
        ],
      },
    ],
  });
}
it("ignores data from a withdrawn source generation", () => {
  const client = new QueryClient();
  const old = ["mod-pull-requests", "demo", "reviews", "detail", "old", "Repo", "42"];
  const healthy = ["mod-pull-requests", "other", "reviews", "detail", "other", "Repo", "42"];
  client.setQueryData(old, "old-secret-data");
  client.setQueryData(healthy, "other-data");
  reconcileModPullRequestCache(client, snapshot("old"), snapshot("new"));
  expect(client.getQueryData(old)).toBeUndefined();
  expect(client.getQueryData(healthy)).toBe("other-data");
  client.clear();
});
it("invalidates inactive source reads without fetching", async () => {
  const client = new QueryClient();
  let calls = 0;
  const key = ["mod-pull-requests", "demo", "reviews", "list", "revision"];
  await client.fetchQuery({
    queryKey: key,
    queryFn: () => {
      calls++;
      return "data";
    },
  });
  await invalidateModPullRequestCache(client, "demo", "reviews");
  expect(calls).toBe(1);
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  client.clear();
});
