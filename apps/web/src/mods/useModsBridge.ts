// FILE: useModsBridge.ts
// Purpose: Keeps the mods store in step with the server and shows mod toasts.
// Layer: Web feature bridge (mounted once by the chat layout; Beta-only)

import { MODS_UNAVAILABLE_ERROR_CODE, type ModToast } from "@synara/contracts";
import { useEffect } from "react";

import { MODS_ON } from "~/betaFeatures";
import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/nativeApi";

import { useModsStore } from "./modsStore";

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

export function useModsBridge(): void {
  useEffect(() => {
    if (!MODS_ON) return;
    const api = readNativeApi();
    if (!api) return;
    const { setSnapshot, setUnavailable } = useModsStore.getState();
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const subscribe = () => {
      unsubscribe = api.mods.onEvent((event) => {
        if (event.type === "snapshot") setSnapshot(event.snapshot);
        else showModToast(event.toast);
      });
    };
    // Ask once before opening the stream: a server that refuses mods would
    // otherwise be asked again on every reconnect. Any other failure still
    // opens the stream, whose first event is a snapshot.
    void api.mods.list().then(
      (snapshot) => {
        if (disposed) return;
        setSnapshot(snapshot);
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
    };
  }, []);
}
