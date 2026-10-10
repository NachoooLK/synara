import type { QueryClient } from "@tanstack/react-query";
import type { ModsSnapshot } from "@synara/contracts";
import { modPullRequestQueryKeys } from "./modPullRequestQueryOptions";
export function invalidateModPullRequestCache(
  client: QueryClient,
  modId: string,
  sourceId: string | null = null,
): Promise<void> {
  return client.invalidateQueries({
    queryKey:
      sourceId === null
        ? modPullRequestQueryKeys.mod(modId)
        : ["mod-pull-requests", modId, sourceId],
    refetchType: "active",
  });
}
export function reconcileModPullRequestCache(
  client: QueryClient,
  previous: ModsSnapshot | null,
  next: ModsSnapshot,
): void {
  const active = new Map(
    next.mods
      .filter((mod) => mod.status === "running")
      .flatMap((mod) =>
        mod.pullRequestSources.map(
          (source) => [JSON.stringify([mod.id, source.source.sourceId]), source.revision] as const,
        ),
      ),
  );
  const knownMods = new Set([...(previous?.mods ?? []), ...next.mods].map((mod) => mod.id));
  for (const query of client.getQueryCache().findAll({ queryKey: modPullRequestQueryKeys.all })) {
    const [, modId, sourceId, , revision] = query.queryKey;
    if (typeof modId !== "string" || !knownMods.has(modId)) continue;
    if (active.get(JSON.stringify([modId, sourceId])) !== revision) {
      void client.cancelQueries({ queryKey: query.queryKey, exact: true });
      client.removeQueries({ queryKey: query.queryKey, exact: true });
    }
  }
  for (const mod of next.mods) {
    const before = previous?.mods.find((value) => value.id === mod.id);
    const changed = mod.mcpSignIns.some((signIn) => {
      const old = before?.mcpSignIns.find((value) => value.server === signIn.server);
      return old?.state !== signIn.state;
    });
    if (!changed) continue;
    const signedOut = mod.mcpSignIns.some((signIn) =>
      before?.mcpSignIns.some(
        (old) =>
          old.server === signIn.server && old.state === "signed-in" && signIn.state !== "signed-in",
      ),
    );
    if (signedOut) void client.resetQueries({ queryKey: modPullRequestQueryKeys.mod(mod.id) });
    else void invalidateModPullRequestCache(client, mod.id);
  }
}
