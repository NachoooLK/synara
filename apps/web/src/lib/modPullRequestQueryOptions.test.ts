import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { ModPullRequestSourceSummary, ModsPullRequestListResult } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { modPullRequestListQueryOptions } from "./modPullRequestQueryOptions";
const list = vi.fn();
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ mods: { pullRequests: { list } } }) }));
afterEach(() => list.mockReset());
it("rejects a reply from a different source revision before caching", async () => {
  const source = Schema.decodeUnknownSync(ModPullRequestSourceSummary)({
    source: { kind: "mod", modId: "demo", sourceId: "reviews" },
    title: "Reviews",
    capabilities: {},
    revision: "current",
  });
  list.mockResolvedValue(
    Schema.decodeUnknownSync(ModsPullRequestListResult)({
      source: source.source,
      revision: "old",
      items: [],
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = modPullRequestListQueryOptions(source, "open", "updated", "cursor/A");
  await expect(client.fetchQuery(options)).rejects.toThrow(/changed|revision/i);
  expect(client.getQueryData(options.queryKey)).toBeUndefined();
  expect(list.mock.calls[0]![0]).toMatchObject({ cursor: "cursor/A", sourceId: "reviews" });
  client.clear();
});
