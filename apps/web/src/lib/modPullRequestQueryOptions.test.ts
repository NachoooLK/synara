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

it("queues more sources than available mod RPC slots without rejecting them", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let active = 0,
    maximum = 0;
  list.mockImplementation(async (input) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    if (maximum > 3) throw new Error("Mod read capacity exceeded");
    return Schema.decodeUnknownSync(ModsPullRequestListResult)({
      source: { kind: "mod", modId: "demo", sourceId: input.sourceId },
      revision: "current",
      items: [],
    });
  });
  const reads = Array.from({ length: 8 }, (_, index) => {
    const source = Schema.decodeUnknownSync(ModPullRequestSourceSummary)({
      source: { kind: "mod", modId: "demo", sourceId: `source-${index}` },
      title: "Reviews",
      revision: "current",
      capabilities: {},
    });
    return client.fetchQuery(modPullRequestListQueryOptions(source, "open", "updated"));
  });
  const results = await Promise.allSettled(reads);
  expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  expect(maximum).toBeLessThanOrEqual(3);
  client.clear();
});
