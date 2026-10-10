import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  ModsPullRequestCommentInput,
  ModsPullRequestActionInput,
  ModsPullRequestSetPinnedInput,
  ModsPullRequestListResult,
  ModsPullRequestDetailResult,
} from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { modPullRequestQueryKeys } from "./modPullRequestQueryOptions";
function refresh(client: QueryClient, input: { modId: string; sourceId: string }) {
  // The write is already acknowledged. A failed read belongs to its query state.
  void client
    .invalidateQueries({
      queryKey: modPullRequestQueryKeys.source({ kind: "mod", ...input }),
      refetchType: "active",
    })
    .catch(() => {});
}
export function modPullRequestCommentMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationKey: ["mod-pull-requests", "comment"],
    retry: false,
    mutationFn: (input: ModsPullRequestCommentInput) =>
      ensureNativeApi().mods.pullRequests.comment(input),
    onSuccess: (_result, input) => refresh(client, input),
  });
}
export function modPullRequestActionMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationKey: ["mod-pull-requests", "action"],
    retry: false,
    mutationFn: (input: ModsPullRequestActionInput) =>
      ensureNativeApi().mods.pullRequests.action(input),
    onSuccess: (_result, input) => refresh(client, input),
  });
}
export function modPullRequestSetPinnedMutationOptions(client: QueryClient) {
  return mutationOptions({
    mutationKey: ["mod-pull-requests", "pin"],
    retry: false,
    mutationFn: (input: ModsPullRequestSetPinnedInput) =>
      ensureNativeApi().mods.pullRequests.setPinned(input),
    onSuccess: (result, input) => {
      const prefix = modPullRequestQueryKeys.source({
        kind: "mod",
        modId: input.modId,
        sourceId: input.sourceId,
      });
      client.setQueriesData<ModsPullRequestListResult | ModsPullRequestDetailResult>(
        { queryKey: prefix },
        (current) => {
          if (!current) return current;
          const patch = <T extends { repository: string; itemId: string; isPinned: boolean }>(
            item: T,
          ): T =>
            item.repository === input.repository && item.itemId === input.itemId
              ? { ...item, isPinned: result.isPinned }
              : item;
          if ("items" in current) return { ...current, items: current.items.map(patch) };
          return "itemId" in current ? patch(current) : current;
        },
      );
    },
  });
}
