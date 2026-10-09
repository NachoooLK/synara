// FILE: useModPaletteActions.ts
// Purpose: Turns the commands of running mods into command palette actions.
// Layer: Web feature hook (Beta-only; empty where mods are off)

import type { ThreadId } from "@synara/contracts";
import { useMemo } from "react";

import { MODS_ON } from "~/betaFeatures";
import type { SidebarSearchAction } from "~/components/SidebarSearchPalette.logic";
import { toastManager } from "~/components/ui/toast";
import { ModIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";

import { useModsStore } from "./modsStore";
import { showModToast } from "./useModsBridge";

export function runModCommand(modId: string, command: string, threadId: ThreadId | null): void {
  void ensureNativeApi()
    .mods.runCommand({ modId, command, threadId })
    .then(
      (result) => {
        if (result.text !== null) showModToast({ modId, text: result.text, tone: "info" });
      },
      (error: unknown) =>
        toastManager.add({
          type: "error",
          title: "The mod command failed",
          description: error instanceof Error ? error.message : "The server did not answer.",
        }),
    );
}

export function useModPaletteActions(threadId: ThreadId | null): SidebarSearchAction[] {
  const snapshot = useModsStore((state) => state.snapshot);
  return useMemo(() => {
    if (!MODS_ON || snapshot === null) return [];
    return snapshot.mods
      .filter((mod) => mod.status === "running")
      .flatMap((mod) =>
        mod.commands.map(
          (command): SidebarSearchAction => ({
            id: `mod-command:${mod.id}:${command.name}`,
            label: command.title,
            description: command.description ?? `A command from the ${mod.id} mod.`,
            keywords: ["mod", mod.id, command.name],
            metaLabel: mod.id,
            run: () => runModCommand(mod.id, command.name, threadId),
            icon: ModIcon,
          }),
        ),
      );
  }, [snapshot, threadId]);
}
