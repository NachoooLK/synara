import { useQueryClient } from "@tanstack/react-query";
import { invalidateModPullRequestCache } from "~/lib/modPullRequestCache";
// FILE: useModsBridge.ts
// Purpose: Keeps the mods store in step with the server and shows mod toasts.
// Layer: Web feature bridge (mounted once by the chat layout; Beta-only)

import {
  MODS_UNAVAILABLE_ERROR_CODE,
  type ModsSnapshot,
  type ModSummary,
  type ModToast,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { MODS_ON } from "~/betaFeatures";
import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/nativeApi";

import { registerModDockViewOpener } from "./ModViewHost";
import { applyModsSnapshot } from "./applyModsSnapshot";
import { useModsStore } from "./modsStore";
import { findNewlyNeededSignIns, findStoppedMods } from "./modsSnapshot.logic";
import { openModDockView } from "./useModDockItems";

function isModsRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === MODS_UNAVAILABLE_ERROR_CODE
  );
}

export function showModToast(toast: Pick<ModToast, "modId" | "text" | "tone">): void {
  toastManager.add({
    type: toast.tone,
    title: toast.text,
    description: `From the ${toast.modId} mod`,
  });
}

/** A crash would otherwise only show in Settings → Mods. */
function showModStoppedToast(mod: ModSummary, openModsSettings: () => void): void {
  if (mod.status === "changed") {
    toastManager.add({
      type: "warning",
      title: `The ${mod.id} mod changed and was stopped`,
      description:
        "Its files are not the ones you enabled. Trust the change in Mods settings to run it again.",
      actionProps: { children: "Open Mods settings", onClick: openModsSettings },
    });
    return;
  }
  toastManager.add({
    type: "error",
    title: `The ${mod.id} mod stopped`,
    description: mod.error ?? "It closed unexpectedly.",
    actionProps: { children: "Open Mods settings", onClick: openModsSettings },
  });
}

/** The mod's views ask too, but none may be open; its calls to the server fail until then. */
function showModSignInNeededToast(modId: string, host: string, openModsSettings: () => void): void {
  toastManager.add({
    type: "warning",
    title: `The ${modId} mod needs you to sign in`,
    description: `Sign in to ${host} in Settings → Mods.`,
    actionProps: { children: "Open Mods settings", onClick: openModsSettings },
  });
}

export function useModsBridge(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!MODS_ON) return;
    const api = readNativeApi();
    if (!api) return;
    const openModsSettings = () => void navigate({ to: "/settings", search: { section: "mods" } });
    // `$.ui.openDockView` opens the view next to the thread the pressed view belongs to.
    registerModDockViewOpener((modId, viewId, context) => {
      if (context.threadId) openModDockView(context.threadId, modId, viewId);
    });
    const { setUnavailable } = useModsStore.getState();
    const applySnapshot = (next: ModsSnapshot) => {
      const previous = useModsStore.getState().snapshot;
      const stopped = findStoppedMods(previous, next);
      const signIns = findNewlyNeededSignIns(previous, next);
      applyModsSnapshot(queryClient, next);
      for (const mod of stopped) showModStoppedToast(mod, openModsSettings);
      for (const { modId, signIn } of signIns) {
        showModSignInNeededToast(modId, signIn.host, openModsSettings);
      }
    };
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const subscribe = () => {
      unsubscribe = api.mods.onEvent((event) => {
        if (event.type === "snapshot") applySnapshot(event.snapshot);
        else if (event.type === "toast") showModToast(event.toast);
        else if (event.type === "pullRequestsInvalidated")
          void invalidateModPullRequestCache(queryClient, event.modId, event.sourceId);
        else useModsStore.getState().invalidate(event.modId, event.viewId);
      });
    };
    // Ask once before opening the stream: a server that refuses mods would
    // otherwise be asked again on every reconnect. Any other failure still
    // opens the stream, whose first event is a snapshot.
    void api.mods.list().then(
      (snapshot) => {
        if (disposed) return;
        applySnapshot(snapshot);
        subscribe();
      },
      (error: unknown) => {
        if (disposed) return;
        if (isModsRefusal(error)) {
          setUnavailable("This Synara server does not offer mods.");
          return;
        }
        subscribe();
      },
    );
    return () => {
      disposed = true;
      unsubscribe?.();
      registerModDockViewOpener(null);
    };
  }, [navigate, queryClient]);
}
