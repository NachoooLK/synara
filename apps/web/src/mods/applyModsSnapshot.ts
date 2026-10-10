import type { ModsSnapshot } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { reconcileModPullRequestCache } from "~/lib/modPullRequestCache";
import { useModsStore } from "./modsStore";

export function applyModsSnapshot(client: QueryClient, next: ModsSnapshot): void {
  reconcileModPullRequestCache(client, useModsStore.getState().snapshot, next);
  useModsStore.getState().setSnapshot(next);
}
