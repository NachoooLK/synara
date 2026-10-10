import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  modPullRequestCommentMutationOptions,
  modPullRequestSetPinnedMutationOptions,
} from "./modPullRequestMutationOptions";
const input = {
  modId: "alpha",
  sourceId: "reviews",
  repository: "Team/Repo",
  itemId: "review/A-α",
};
afterEach(() => vi.unstubAllGlobals());
it("keeps mutation success when detail refresh fails", async () => {
  const comment = vi.fn(async () => ({ ok: true as const, mergeOutcome: null }));
  vi.stubGlobal("window", { nativeApi: { mods: { pullRequests: { comment } } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, {
    queryKey: [
      "mod-pull-requests",
      "alpha",
      "reviews",
      "detail",
      "current",
      "Team/Repo",
      "review/A-α",
    ],
    initialData: "old detail",
    staleTime: Infinity,
    queryFn: async () => {
      throw new Error("refresh failed");
    },
  });
  const stop = observer.subscribe(() => {});
  const mutation = client
    .getMutationCache()
    .build(client, modPullRequestCommentMutationOptions(client));
  await expect(mutation.execute({ ...input, body: "One comment" })).resolves.toEqual({
    ok: true,
    mergeOutcome: null,
  });
  await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
  expect(mutation.state.status).toBe("success");
  expect(comment).toHaveBeenCalledTimes(1);
  expect(observer.getCurrentResult().data).toBe("old detail");
  stop();
  client.clear();
});
it("isolates overlapping source pins", async () => {
  vi.stubGlobal("window", {
    nativeApi: {
      mods: {
        pullRequests: {
          setPinned: async () => ({
            source: { kind: "mod", modId: "alpha", sourceId: "reviews" },
            repository: input.repository,
            itemId: input.itemId,
            isPinned: true,
          }),
        },
      },
    },
  });
  const client = new QueryClient();
  const key = (modId: string) => ["mod-pull-requests", modId, "reviews", "list", "current"];
  const row = { repository: input.repository, itemId: input.itemId, isPinned: false };
  client.setQueryData(key("alpha"), { items: [row] });
  client.setQueryData(key("beta"), { items: [row] });
  client.setQueryData(["github-inbox", "list"], { items: [row] });
  await client
    .getMutationCache()
    .build(client, modPullRequestSetPinnedMutationOptions(client))
    .execute({ ...input, isPinned: true });
  expect(client.getQueryData<{ items: (typeof row)[] }>(key("alpha"))!.items[0]!.isPinned).toBe(
    true,
  );
  expect(client.getQueryData<{ items: (typeof row)[] }>(key("beta"))!.items[0]!.isPinned).toBe(
    false,
  );
  expect(
    client.getQueryData<{ items: (typeof row)[] }>(["github-inbox", "list"])!.items[0]!.isPinned,
  ).toBe(false);
  client.clear();
});
