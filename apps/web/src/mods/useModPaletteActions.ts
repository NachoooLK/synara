// FILE: useModPaletteActions.ts
// Purpose: The command palette's mods entries: "Open Mods settings", "Import mod…", and
//          the commands of running mods (listed only once the person types).
// Layer: Web feature hook (Beta-only; empty where mods are off)

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { MODS_ON } from "~/betaFeatures";
import type { SidebarSearchAction } from "~/components/SidebarSearchPalette.logic";
import { toastManager } from "~/components/ui/toast";
import { DownloadIcon, ModIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";

import { useModsStore } from "./modsStore";
import { showModToast } from "./useModsBridge";

/** Runs a mod command; `title` names it in the error toast and defaults to its name. */
export function runModCommand(
  modId: string,
  command: string,
  threadId: ThreadId | null,
  title: string = command,
): void {
  void ensureNativeApi()
    .mods.runCommand({ modId, command, threadId })
    .then(
      (result) => {
        if (result.text !== null) showModToast({ modId, text: result.text, tone: "info" });
      },
      (error: unknown) => {
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "The server did not answer.";
        toastManager.add({
          type: "error",
          title: `Could not run “${title}”`,
          description: `${message} (from the ${modId} mod)`,
        });
      },
    );
}

export function useModPaletteActions(threadId: ThreadId | null): SidebarSearchAction[] {
  const snapshot = useModsStore((state) => state.snapshot);
  const navigate = useNavigate();
  return useMemo(() => {
    if (!MODS_ON) return [];
    const openModsSettings = () => void navigate({ to: "/settings", search: { section: "mods" } });
    const settingsActions: SidebarSearchAction[] = [
      {
        id: "mods-settings",
        label: "Open Mods settings",
        description: "Enable, reload, import and export mods.",
        keywords: ["mods", "mod", "plugins", "extensions", "settings"],
        run: openModsSettings,
        icon: ModIcon,
      },
      {
        id: "mods-import",
        label: "Import mod…",
        description: "Open Mods settings to import an exported .synara-mod.json file.",
        keywords: ["mods", "mod", "import", "install", "plugins", "extensions"],
        requiresQuery: true,
        run: openModsSettings,
        icon: DownloadIcon,
      },
    ];
    if (snapshot === null) return settingsActions;
    const commandActions = snapshot.mods
      .filter((mod) => mod.status === "running")
      .flatMap((mod) =>
        mod.commands.map(
          (command): SidebarSearchAction => ({
            id: `mod-command:${mod.id}:${command.name}`,
            label: command.title,
            description: command.description ?? `A command from the ${mod.id} mod.`,
            keywords: ["mod", "mods", mod.id, command.name],
            metaLabel: mod.id,
            // Listing every command in the empty palette would push threads below the fold.
            requiresQuery: true,
            run: () => runModCommand(mod.id, command.name, threadId, command.title),
            icon: ModIcon,
          }),
        ),
      );
    return [...settingsActions, ...commandActions];
  }, [navigate, snapshot, threadId]);
}
