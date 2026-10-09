// FILE: useModSidebarRailItems.ts
// Purpose: One rail button per sidebar view of a running mod.
// Layer: Web mods UI (Beta-only; empty where mods are off)

import { useMemo } from "react";

import { MODS_ON } from "~/betaFeatures";
import { type AppRailItem, railCentralGlyphs } from "~/components/AppRail";

import { useModsStore } from "./modsStore";
import type { ModSidebarViewRef } from "./modSidebarStore";

const DEFAULT_MOD_VIEW_ICON = "magic-wand";

export function modSidebarRailItemId(view: ModSidebarViewRef): string {
  return `mod:${view.modId}:${view.viewId}`;
}

export function useModSidebarRailItems(
  activeView: ModSidebarViewRef | null,
  onSelect: (view: ModSidebarViewRef) => void,
): AppRailItem[] {
  const snapshot = useModsStore((state) => state.snapshot);
  return useMemo(() => {
    if (!MODS_ON || snapshot === null) return [];
    return snapshot.mods
      .filter((mod) => mod.status === "running")
      .flatMap((mod) =>
        mod.views
          .filter((view) => view.site === "sidebar")
          .map((view): AppRailItem => {
            const ref = { modId: mod.id, viewId: view.id };
            return {
              id: modSidebarRailItemId(ref),
              glyphs: railCentralGlyphs(view.icon ?? DEFAULT_MOD_VIEW_ICON),
              label: view.title,
              badge: null,
              active: activeView?.modId === mod.id && activeView.viewId === view.id,
              onSelect: () => onSelect(ref),
            };
          }),
      );
  }, [snapshot, activeView, onSelect]);
}
