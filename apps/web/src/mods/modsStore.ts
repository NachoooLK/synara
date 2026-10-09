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
  readonly setSnapshot: (snapshot: ModsSnapshot) => void;
  readonly setUnavailable: (message: string) => void;
}

export const useModsStore = create<ModsState>()((set) => ({
  availability: { kind: "loading" },
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot, availability: { kind: "available" } }),
  setUnavailable: (message) => set({ availability: { kind: "unavailable", message } }),
}));
