// FILE: modsSnapshot.logic.ts
// Purpose: Pure reads of the mods snapshot for the UI: where each view lives, what an
//          enabled mod added, and which mods stopped or began asking for a sign-in
//          between two snapshots.
// Layer: Web mods logic (no React, no store)

import type { ModMcpSignIn, ModsSnapshot, ModSummary, ModViewSite } from "@synara/contracts";

/** Where a view of each site appears, as the person sees it. */
export const MOD_VIEW_SITE_LABELS: Record<ModViewSite, string> = {
  sidebar: "Sidebar",
  dock: "Dock",
  band: "Above the composer",
  header: "Thread header",
};

/** "Kitchen sink (Sidebar), All elements (Dock)", or null when the mod has no views. */
export function describeModViews(mod: Pick<ModSummary, "views">): string | null {
  if (mod.views.length === 0) return null;
  return mod.views.map((view) => `${view.title} (${MOD_VIEW_SITE_LABELS[view.site]})`).join(", ");
}

/**
 * What a running mod added to Synara: "Added: Kitchen sink (sidebar), 3 commands",
 * or null when it only runs hooks.
 */
export function describeModAdditions(mod: Pick<ModSummary, "views" | "commands">): string | null {
  const parts = mod.views.map(
    (view) => `${view.title} (${MOD_VIEW_SITE_LABELS[view.site].toLowerCase()})`,
  );
  if (mod.commands.length > 0) {
    parts.push(`${mod.commands.length} command${mod.commands.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? `Added: ${parts.join(", ")}` : null;
}

/**
 * Mods that were running in `previous` and are stopped in `next` without the person
 * asking: in error (a crash, a failed reload) or changed (their files are not the ones
 * that were trusted). Turning a mod off moves it to "disabled", and the first snapshot
 * has nothing to compare with, so neither counts.
 */
export function findStoppedMods(
  previous: ModsSnapshot | null,
  next: ModsSnapshot,
): readonly ModSummary[] {
  if (previous === null) return [];
  const wasRunning = new Set(
    previous.mods.filter((mod) => mod.status === "running").map((mod) => mod.id),
  );
  return next.mods.filter(
    (mod) => (mod.status === "error" || mod.status === "changed") && wasRunning.has(mod.id),
  );
}

/**
 * Servers a mod that is on began asking the person to sign in to: `needed` in `next`
 * and unknown before, or signed in before and ended by the server (it says why in
 * `detail`). Signing out is the person's own doing, a mod that is off asks for nothing
 * yet, and the first snapshot has nothing to compare with, so none of those count.
 */
export function findNewlyNeededSignIns(
  previous: ModsSnapshot | null,
  next: ModsSnapshot,
): ReadonlyArray<{ readonly modId: string; readonly signIn: ModMcpSignIn }> {
  if (previous === null) return [];
  const before = new Map(
    previous.mods.flatMap((mod) =>
      mod.mcpSignIns.map((signIn) => [`${mod.id}:${signIn.server}`, signIn.state] as const),
    ),
  );
  return next.mods
    .filter((mod) => mod.status === "running" || mod.status === "starting")
    .flatMap((mod) =>
      mod.mcpSignIns
        .filter((signIn) => {
          if (signIn.state !== "needed") return false;
          const was = before.get(`${mod.id}:${signIn.server}`);
          return was === undefined || (was === "signed-in" && signIn.detail !== null);
        })
        .map((signIn) => ({ modId: mod.id, signIn })),
    );
}
