// FILE: modsStore.ts
// Purpose: The client's copy of the server's mods snapshot, fed by useModsBridge.
// Layer: Web state (not persisted; the server owns which mods are enabled)

import type { ModsSnapshot } from "@synara/contracts";
import { create } from "zustand";

export type ModsAvailability =
  | { readonly kind: "loading" }
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly message: string };

interface ModsState {
  readonly availability: ModsAvailability;
  readonly snapshot: ModsSnapshot | null;
  /**
   * Redraw counters: `<modId>:<viewId>` for one view, `<modId>:*` for every view
   * of a mod. A mounted view draws again when either of its counters moves.
   */
  readonly viewVersions: Readonly<Record<string, number>>;
  readonly setSnapshot: (snapshot: ModsSnapshot) => void;
  readonly setUnavailable: (message: string) => void;
  readonly invalidate: (modId: string, viewId: string | null) => void;
}

export function modViewVersionKey(modId: string, viewId: string | null): string {
  return `${modId}:${viewId ?? "*"}`;
}

export const useModsStore = create<ModsState>()((set) => ({
  availability: { kind: "loading" },
  snapshot: null,
  viewVersions: {},
  setSnapshot: (snapshot) => set({ snapshot, availability: { kind: "available" } }),
  setUnavailable: (message) => set({ availability: { kind: "unavailable", message } }),
  invalidate: (modId, viewId) =>
    set((state) => {
      const key = modViewVersionKey(modId, viewId);
      return { viewVersions: { ...state.viewVersions, [key]: (state.viewVersions[key] ?? 0) + 1 } };
    }),
}));
