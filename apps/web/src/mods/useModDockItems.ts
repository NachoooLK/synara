// FILE: useModDockItems.ts
// Purpose: The dock's entries for the dock views of running mods, and their tab titles.
// Layer: Web mods UI (Beta-only; empty where mods are off)

import type { ThreadId } from "@synara/contracts";
import { createElement, useCallback, useMemo } from "react";

import { MODS_ON } from "~/betaFeatures";
import type { RightDockLauncherItem } from "~/components/chat/rightDockPaneMeta";
import { createCentralIconComponent } from "~/lib/central-icons";
import { type LucideIcon, ModIcon } from "~/lib/icons";
import { useRightDockStore } from "~/rightDockStore";

import { useModsStore } from "./modsStore";

// One component per icon name, so a new snapshot does not remount every menu glyph.
const viewIconComponents = new Map<string, LucideIcon>();

/** The view's Central icon; null (no icon, or one the server did not know) is the mod glyph. */
function modViewIcon(icon: string | null): LucideIcon {
  if (icon === null) return ModIcon;
  const cached = viewIconComponents.get(icon);
  if (cached) return cached;
  const Glyph = createCentralIconComponent(icon);
  const component: LucideIcon = ({ className }) =>
    createElement(Glyph, className === undefined ? {} : { className });
  viewIconComponents.set(icon, component);
  return component;
}

export function openModDockView(threadId: ThreadId, modId: string, viewId: string): void {
  useRightDockStore.getState().openPane(threadId, { kind: "mod", modId, modViewId: viewId });
}

export function useModDockItems(threadId: ThreadId): {
  readonly launcherItems: readonly RightDockLauncherItem[];
  readonly viewTitle: (modId: string, viewId: string) => string | undefined;
  /** The glyph of a mod's dock view, for its open tab. */
  readonly viewIcon: (modId: string, viewId: string) => LucideIcon;
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
            Icon: modViewIcon(view.icon),
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
  const viewIcon = useCallback(
    (modId: string, viewId: string) =>
      modViewIcon(
        snapshot?.mods.find((mod) => mod.id === modId)?.views.find((view) => view.id === viewId)
          ?.icon ?? null,
      ),
    [snapshot],
  );
  return { launcherItems, viewTitle, viewIcon };
}
