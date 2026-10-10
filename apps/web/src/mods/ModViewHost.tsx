// FILE: ModViewHost.tsx
// Purpose: Mounts one view of a mod: asks the server to draw it, draws it again
//          when the mod or Synara's data changes, and sends presses back to the
//          mod, applying what the handler asked of the window. While the mod waits
//          for a sign-in to one of its MCP servers, asks for it where the failed
//          draw would show.
// Layer: Web mods UI

import type {
  ModMcpSignIn,
  ModUiEffect,
  ModUiTree,
  ModViewContext,
  ModViewSite,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";

import { startModMcpSignIn } from "./modMcpSignIn";
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

/**
 * Asks for the sign-in to one MCP server the mod cannot call without it. `slim` is
 * the one line above a view the mod drew anyway; otherwise it stands in for the view.
 */
function ModSignInRequest(props: { modId: string; signIn: ModMcpSignIn; slim?: boolean }) {
  const { modId, signIn } = props;
  const [pending, setPending] = useState(false);
  const [pageOpened, setPageOpened] = useState(false);
  const text = `The ${modId} mod needs you to sign in to ${signIn.host}.`;
  const hint = "Finish signing in in your browser.";
  const button = (
    <Button
      size="xs"
      variant="outline"
      disabled={pending}
      onClick={() => {
        setPending(true);
        void startModMcpSignIn(modId, signIn.server)
          .then((opened) => {
            if (opened) setPageOpened(true);
          })
          .finally(() => setPending(false));
      }}
    >
      Sign in
    </Button>
  );

  if (props.slim) {
    // One line has room for one sentence: the hint takes the request's place.
    const line = pageOpened ? hint : text;
    return (
      <div className="mx-2 my-1 flex items-center justify-between gap-2 rounded-md border border-warning/32 bg-warning/4 px-2 py-1 text-ui-sm text-foreground">
        <span title={line} className="min-w-0 truncate">
          {line}
        </span>
        {button}
      </div>
    );
  }
  return (
    <div className="flex max-w-full flex-col items-center gap-3">
      <span className="max-w-full break-words">{text}</span>
      {button}
      {pageOpened ? <span>{hint}</span> : null}
    </div>
  );
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
  // Quiet sites have no room to ask; the mod's other views and Settings → Mods do.
  const signInsNeeded =
    !quiet && status === "running"
      ? (mod?.mcpSignIns ?? []).filter((signIn) => signIn.state === "needed")
      : [];
  const signInNeeded = signInsNeeded.length > 0;
  const [state, setState] = useState<ViewState>({ tree: null, error: null, loaded: false });
  const [retry, setRetry] = useState(0);
  // One render in flight per view; requests that arrive meanwhile collapse into
  // one more, with the newest inputs, so a burst of redraws costs two renders.
  const inFlight = useRef(false);
  const queued = useRef(false);
  const renderLatest = useRef<() => void>(() => undefined);
  const lastTreeJson = useRef<string | null>(null);

  useLayoutEffect(() => {
    lastTreeJson.current = null;
    setState({ tree: null, error: null, loaded: false });
  }, [modId, viewId, loadedAt, status]);

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
    // A view that failed for want of a sign-in draws again once the person has signed in.
    signInNeeded,
    retry,
  ]);

  // The error a sign-in request stood in for is out of date once the sign-in is
  // there: drop it before it shows, while the view draws again.
  useLayoutEffect(() => {
    if (signInNeeded) return;
    setState((previous) =>
      previous.error === null
        ? previous
        : { ...previous, error: null, loaded: previous.tree !== null },
    );
  }, [signInNeeded]);

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
                : status === "changed"
                  ? `The ${modId} mod changed since you enabled it, so it is stopped until you trust the change.`
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
      {state.error && !signInNeeded ? (
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
      ) : signInNeeded && (state.error !== null || state.tree === null) ? (
        // The failed draw is the missing sign-in, so the request takes its place. It
        // grows past a short panel instead of losing its top to the centering.
        <PanelStateMessage className="h-auto min-h-full flex-col gap-5">
          {signInsNeeded.map((signIn) => (
            <ModSignInRequest key={signIn.server} modId={modId} signIn={signIn} />
          ))}
        </PanelStateMessage>
      ) : state.tree === null && state.error === null ? (
        <PanelStateMessage>Nothing to show.</PanelStateMessage>
      ) : (
        <>
          {/* The mod drew through the failure itself; its view stays, under the request. */}
          {signInsNeeded.map((signIn) => (
            <ModSignInRequest key={signIn.server} modId={modId} signIn={signIn} slim />
          ))}
          <ModUiRenderer tree={state.tree} dispatch={dispatch} site={props.site} />
        </>
      )}
    </div>
  );
}
