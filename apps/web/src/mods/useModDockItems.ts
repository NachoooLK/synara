// FILE: useModDockItems.ts
// Purpose: The dock's entries for the dock views of running mods, and their tab titles.
// Layer: Web mods UI (Beta-only; empty where mods are off)

import type { ThreadId } from "@synara/contracts";
import { useCallback, useMemo } from "react";

import { MODS_ON } from "~/betaFeatures";
import type { RightDockLauncherItem } from "~/components/chat/rightDockPaneMeta";
import { ModIcon } from "~/lib/icons";
import { useRightDockStore } from "~/rightDockStore";

import { useModsStore } from "./modsStore";

export function openModDockView(threadId: ThreadId, modId: string, viewId: string): void {
  useRightDockStore.getState().openPane(threadId, { kind: "mod", modId, modViewId: viewId });
}

export function useModDockItems(threadId: ThreadId): {
  readonly launcherItems: readonly RightDockLauncherItem[];
  readonly viewTitle: (modId: string, viewId: string) => string | undefined;
} {
  const snapshot = useModsStore((state) => state.snapshot);
  const launcherItems = useMemo((): RightDockLauncherItem[] => {
    if (!MODS_ON || snapshot === null) return [];
    return snapshot.mods
      .filter((mod) => mod.status === "running")
      .flatMap((mod) =>
        mod.views
          .filter((view) => view.site === "dock")
          .map((view) => ({
            kind: "mod" as const,
            key: `mod:${mod.id}:${view.id}`,
            label: view.title,
            Icon: ModIcon,
            onOpen: () => openModDockView(threadId, mod.id, view.id),
          })),
      );
  }, [snapshot, threadId]);
  const viewTitle = useCallback(
    (modId: string, viewId: string) =>
      snapshot?.mods.find((mod) => mod.id === modId)?.views.find((view) => view.id === viewId)
        ?.title,
    [snapshot],
  );
  return { launcherItems, viewTitle };
}
