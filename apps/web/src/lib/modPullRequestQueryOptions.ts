// No polling: the mounted Code review page owns every mod read.
import { queryOptions } from "@tanstack/react-query";
import type {
  ModPullRequestSourceSummary,
  ModPullRequestIdentity,
  GitHubInboxState,
  GitHubInboxSort,
  ModPullRequestSourceRef,
} from "@synara/contracts";
import { MODS_ON } from "~/betaFeatures";
import { ensureNativeApi } from "~/nativeApi";
export const modPullRequestQueryKeys = {
  all: ["mod-pull-requests"] as const,
  mod: (modId: string) => ["mod-pull-requests", modId] as const,
  source: (ref: ModPullRequestSourceRef) => ["mod-pull-requests", ref.modId, ref.sourceId] as const,
  list: (
    source: ModPullRequestSourceSummary,
    state: GitHubInboxState,
    sort: GitHubInboxSort,
    cursor: string | null,
  ) =>
    [
      "mod-pull-requests",
      source.source.modId,
      source.source.sourceId,
      "list",
      source.revision,
      state,
      sort,
      cursor,
    ] as const,
  item: (
    source: ModPullRequestSourceSummary | null,
    operation: "detail" | "diff",
    identity: ModPullRequestIdentity | null,
  ) =>
    [
      "mod-pull-requests",
      source?.source.modId ?? null,
      source?.source.sourceId ?? null,
      operation,
      source?.revision ?? null,
      identity?.repository ?? null,
      identity?.itemId ?? null,
    ] as const,
};
const behavior = {
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  refetchInterval: false as const,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false as const,
};
function checkRevision(
  source: ModPullRequestSourceSummary,
  result: { revision: string; source: ModPullRequestSourceRef },
): void {
  if (
    result.revision !== source.revision ||
    result.source.modId !== source.source.modId ||
    result.source.sourceId !== source.source.sourceId
  )
    throw new Error(
      "This source changed while loading. Wait for its current registration and refresh.",
    );
}
export function modPullRequestListQueryOptions(
  source: ModPullRequestSourceSummary,
  state: GitHubInboxState,
  sort: GitHubInboxSort,
  cursor: string | null = null,
) {
  return queryOptions({
    ...behavior,
    enabled: MODS_ON,
    queryKey: modPullRequestQueryKeys.list(source, state, sort, cursor),
    queryFn: async ({ signal }) => {
      const result = await ensureNativeApi().mods.pullRequests.list({
        modId: source.source.modId,
        sourceId: source.source.sourceId,
        state,
        sort,
        cursor,
        limit: 100,
      });
      signal.throwIfAborted();
      checkRevision(source, result);
      return result;
    },
  });
}
export function modPullRequestDetailQueryOptions(
  source: ModPullRequestSourceSummary | null,
  identity: ModPullRequestIdentity | null,
) {
  return queryOptions({
    ...behavior,
    enabled: MODS_ON && source !== null && identity !== null,
    queryKey: modPullRequestQueryKeys.item(source, "detail", identity),
    queryFn: async ({ signal }) => {
      if (!source || !identity) throw new Error("This mod source is unavailable.");
      const result = await ensureNativeApi().mods.pullRequests.detail({
        ...identity,
        modId: source.source.modId,
        sourceId: source.source.sourceId,
      });
      signal.throwIfAborted();
      checkRevision(source, result);
      return result;
    },
  });
}
export function modPullRequestDiffQueryOptions(
  source: ModPullRequestSourceSummary | null,
  identity: ModPullRequestIdentity | null,
  enabled = true,
) {
  return queryOptions({
    ...behavior,
    enabled: MODS_ON && enabled && source?.capabilities.diff === true && identity !== null,
    queryKey: modPullRequestQueryKeys.item(source, "diff", identity),
    queryFn: async ({ signal }) => {
      if (!source || !identity) throw new Error("This mod source is unavailable.");
      const result = await ensureNativeApi().mods.pullRequests.diff({
        ...identity,
        modId: source.source.modId,
        sourceId: source.source.sourceId,
      });
      signal.throwIfAborted();
      return result;
    },
  });
}
