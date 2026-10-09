// FILE: modSidebarStore.ts
// Purpose: Which mod view, if any, replaces the thread list in the sidebar panel.
// Layer: Web mods UI state (per window, not persisted)

import { create } from "zustand";

export interface ModSidebarViewRef {
  readonly modId: string;
  readonly viewId: string;
}

interface ModSidebarState {
  readonly activeView: ModSidebarViewRef | null;
  readonly select: (view: ModSidebarViewRef) => void;
  readonly clear: () => void;
}

export const useModSidebarStore = create<ModSidebarState>()((set) => ({
  activeView: null,
  select: (view) => set({ activeView: view }),
  clear: () => set((state) => (state.activeView === null ? state : { activeView: null })),
}));
