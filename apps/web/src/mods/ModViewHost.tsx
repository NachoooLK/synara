// FILE: ModViewHost.tsx
// Purpose: Mounts one view of a mod: asks the server to draw it, draws it again
//          when the mod or Synara's data changes, and sends presses back to the
//          mod, applying what the handler asked of the window.
// Layer: Web mods UI

import type { ModUiEffect, ModUiTree, ModViewContext, ModViewSite } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
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
  /** Where the view is drawn; elements match that place's own controls. */
  site?: ModViewSite;
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
  const mod = useModsStore((state) => state.snapshot?.mods.find((entry) => entry.id === modId));
  // A reload replaces the mod's handlers, so the view draws again after one.
  const loadedAt = mod?.loadedAt ?? null;
  const status = mod?.status ?? null;
  const modError = mod?.error ?? null;
  const [state, setState] = useState<ViewState>({ tree: null, error: null, loaded: false });
  const [retry, setRetry] = useState(0);
  // One render in flight per view; requests that arrive meanwhile collapse into
  // one more, with the newest inputs, so a burst of redraws costs two renders.
  const inFlight = useRef(false);
  const queued = useRef(false);
  const renderLatest = useRef<() => void>(() => undefined);
  const lastTreeJson = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "running") return;
    let current = true;
    renderLatest.current = () => {
      inFlight.current = true;
      void ensureNativeApi()
        .mods.renderView({
          modId,
          viewId,
          context: { threadId: context.threadId, projectId: context.projectId },
        })
        .then(
          (result) => {
            if (!current) return;
            // Most redraws during a turn return the same tree; skip drawing it again.
            const json = JSON.stringify(result.tree);
            if (json === lastTreeJson.current) {
              setState((previous) =>
                previous.error === null && previous.loaded
                  ? previous
                  : { ...previous, error: null, loaded: true },
              );
              return;
            }
            lastTreeJson.current = json;
            setState({ tree: result.tree, error: null, loaded: true });
          },
          (error: unknown) => {
            if (!current) return;
            // Keep the last tree on screen; the error shows above it.
            setState((previous) => ({
              ...previous,
              error: error instanceof Error ? error.message : "The mod could not draw this view.",
              loaded: true,
            }));
          },
        )
        .finally(() => {
          inFlight.current = false;
          if (queued.current) {
            queued.current = false;
            renderLatest.current();
          }
        });
    };
    if (inFlight.current) queued.current = true;
    else renderLatest.current();
    return () => {
      current = false;
    };
  }, [
    modId,
    viewId,
    context.threadId,
    context.projectId,
    viewVersion,
    modVersion,
    loadedAt,
    status,
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
    return ensureNativeApi()
      .mods.dispatchUi({ modId, handlerId, payload: (payload ?? null) as never })
      .then(
        (result) => {
          for (const effect of result.effects) applyEffect(effect);
          return true;
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : "The mod did not answer.";
          if (message.includes(STALE_HANDLER_MESSAGE)) {
            setRetry((count) => count + 1);
            return false;
          }
          toastManager.add({
            type: "error",
            title: "Could not finish that action",
            description: `${message} (from the ${modId} mod)`,
          });
          return false;
        },
      );
  };

  const openModsSettings = () => void navigate({ to: "/settings", search: { section: "mods" } });

  if (quiet) {
    if (status !== "running" || state.tree === null) return null;
    const content = (
      <div className={props.className}>
        <ModUiRenderer tree={state.tree} dispatch={dispatch} site={props.site} />
      </div>
    );
    return props.frame ? props.frame(content) : content;
  }

  if (status !== "running") {
    return (
      <div className={cn("flex min-h-0 min-w-0 flex-col", props.className)}>
        <PanelStateMessage className="flex-col gap-3">
          <span>
            {status === "starting"
              ? `The ${modId} mod is starting…`
              : status === "error"
                ? `The ${modId} mod stopped${modError ? `: ${modError}` : "."}`
                : `The ${modId} mod is off.`}
          </span>
          {status === "starting" ? null : (
            <Button size="xs" variant="outline" onClick={openModsSettings}>
              Open Mods settings
            </Button>
          )}
        </PanelStateMessage>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col [&>*]:shrink-0", props.className)}>
      {state.error ? (
        <div
          role="alert"
          className="mx-2 my-1 flex items-start justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/6 px-2 py-1.5 text-ui-sm text-destructive"
        >
          <span className="min-w-0 break-words whitespace-pre-wrap">{state.error}</span>
          <span className="flex shrink-0 items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => setRetry((count) => count + 1)}>
              Retry
            </Button>
            <Button size="xs" variant="ghost" onClick={openModsSettings}>
              Log
            </Button>
          </span>
        </div>
      ) : null}
      {!state.loaded ? (
        <PanelStateMessage>
          <Spinner className="size-4" aria-label="Loading the view" />
        </PanelStateMessage>
      ) : state.tree === null && state.error === null ? (
        <PanelStateMessage>Nothing to show.</PanelStateMessage>
      ) : (
        <ModUiRenderer tree={state.tree} dispatch={dispatch} site={props.site} />
      )}
    </div>
  );
}
