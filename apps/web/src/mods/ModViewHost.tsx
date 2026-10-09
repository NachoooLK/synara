// FILE: ModViewHost.tsx
// Purpose: Mounts one view of a mod: asks the server to draw it, draws it again
//          when the mod or Synara's data changes, and sends presses back to the
//          mod, applying what the handler asked of the window.
// Layer: Web mods UI

import type { ModUiEffect, ModUiTree, ModViewContext } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

import { ModUiRenderer, type ModUiDispatch } from "./ModUiRenderer";
import { modViewVersionKey, useModsStore } from "./modsStore";

/** The window-side half of `$.ui.openDockView`; the dock registers it. */
let openDockView: ((modId: string, viewId: string, context: ModViewContext) => void) | null = null;

export function registerModDockViewOpener(
  opener: ((modId: string, viewId: string, context: ModViewContext) => void) | null,
): void {
  openDockView = opener;
}

const STALE_HANDLER_MESSAGE = "This control is out of date";

interface ViewState {
  readonly tree: ModUiTree | null;
  readonly error: string | null;
  readonly loaded: boolean;
}

export function ModViewHost(props: {
  modId: string;
  viewId: string;
  context: ModViewContext;
  className?: string;
  /** Hides errors and loading for small sites (band, header) where a notice would not fit. */
  quiet?: boolean;
  /** Quiet sites: wraps the drawn tree (never an empty one) in the site's own chrome. */
  frame?: (content: ReactNode) => ReactNode;
}) {
  const { modId, viewId, context, quiet = false } = props;
  const navigate = useNavigate();
  const viewVersion = useModsStore(
    (state) => state.viewVersions[modViewVersionKey(modId, viewId)] ?? 0,
  );
  const modVersion = useModsStore(
    (state) => state.viewVersions[modViewVersionKey(modId, null)] ?? 0,
  );
  // A reload replaces the mod's handlers, so the view draws again after one.
  const loadedAt = useModsStore(
    (state) => state.snapshot?.mods.find((mod) => mod.id === modId)?.loadedAt ?? null,
  );
  const [state, setState] = useState<ViewState>({ tree: null, error: null, loaded: false });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void ensureNativeApi()
      .mods.renderView({
        modId,
        viewId,
        context: { threadId: context.threadId, projectId: context.projectId },
      })
      .then(
        (result) => {
          if (!cancelled) setState({ tree: result.tree, error: null, loaded: true });
        },
        (error: unknown) => {
          if (cancelled) return;
          // Keep the last tree on screen; the error shows above it.
          setState((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : "The mod could not draw this view.",
            loaded: true,
          }));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [
    modId,
    viewId,
    context.threadId,
    context.projectId,
    viewVersion,
    modVersion,
    loadedAt,
    retry,
  ]);

  const applyEffect = (effect: ModUiEffect) => {
    switch (effect.type) {
      case "openThread":
        void navigate({ to: "/$threadId", params: { threadId: effect.threadId } });
        return;
      case "openUrl":
        openExternalLink(effect.url);
        return;
      case "openDockView":
        openDockView?.(effect.modId, effect.viewId, context);
        return;
    }
  };

  const dispatch: ModUiDispatch = (handler, payload) => {
    const handlerId = (handler as { readonly $handler: string }).$handler;
    void ensureNativeApi()
      .mods.dispatchUi({ modId, handlerId, payload: (payload ?? null) as never })
      .then(
        (result) => {
          for (const effect of result.effects) applyEffect(effect);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : "The mod did not answer.";
          if (message.includes(STALE_HANDLER_MESSAGE)) {
            setRetry((count) => count + 1);
            return;
          }
          toastManager.add({
            type: "error",
            title: `The ${modId} mod failed`,
            description: message,
          });
        },
      );
  };

  if (quiet) {
    if (state.tree === null) return null;
    const content = (
      <div className={props.className}>
        <ModUiRenderer tree={state.tree} dispatch={dispatch} />
      </div>
    );
    return props.frame ? props.frame(content) : content;
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", props.className)}>
      {state.error ? (
        <div className="mx-2 my-1 flex items-start justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/6 px-2 py-1.5 text-ui-sm text-destructive">
          <span className="min-w-0 break-words whitespace-pre-wrap">{state.error}</span>
          <button
            type="button"
            className="shrink-0 underline-offset-2 hover:underline"
            onClick={() => setRetry((count) => count + 1)}
          >
            Retry
          </button>
        </div>
      ) : null}
      {!state.loaded ? (
        <span className="px-3 py-2 text-ui-sm text-muted-foreground">Loading…</span>
      ) : (
        <ModUiRenderer tree={state.tree} dispatch={dispatch} />
      )}
    </div>
  );
}
