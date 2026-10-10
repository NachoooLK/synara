import type { ModSummary, ModMcpSignIn } from "@synara/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";
import { startModMcpSignIn } from "./modMcpSignIn";
import { useQueryClient } from "@tanstack/react-query";
import { applyModsSnapshot } from "./applyModsSnapshot";

/** One MCP server of the mod that asks for a sign-in, with the button that starts or ends it. */
export function ModMcpSignInLine({ mod, signIn }: { mod: ModSummary; signIn: ModMcpSignIn }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [pageOpened, setPageOpened] = useState(false);

  const start = async () => {
    setPending(true);
    try {
      if (await startModMcpSignIn(mod.id, signIn.server)) setPageOpened(true);
    } finally {
      setPending(false);
    }
  };

  const signOut = async () => {
    setPending(true);
    try {
      applyModsSnapshot(
        queryClient,
        await ensureNativeApi().mods.mcpSignOut({ id: mod.id, server: signIn.server }),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not sign out",
        description: error instanceof Error ? error.message : "The server did not answer.",
      });
    } finally {
      setPending(false);
    }
  };

  if (signIn.state === "signed-in") {
    const text = `Signed in to ${signIn.host}`;
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span title={text} className="line-clamp-2 min-w-0 break-words">
          {text}
        </span>
        <Button size="xs" variant="outline" disabled={pending} onClick={() => void signOut()}>
          Sign out
        </Button>
      </span>
    );
  }

  // The server starts a sign-in only for a mod that is on.
  const blockedReason = !mod.enabled
    ? "Turn the mod on first."
    : mod.status === "changed"
      ? "Trust the mod's changes first."
      : null;
  const text = `Needs you to sign in to ${signIn.host}${signIn.detail === null ? "" : `: ${signIn.detail}`}`;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span title={text} className="line-clamp-2 min-w-0 break-words">
        {text}
      </span>
      {/* A disabled button takes no hover, so the reason sits on its wrapper. */}
      <span title={blockedReason ?? undefined} className="inline-flex shrink-0">
        <Button
          size="xs"
          variant="outline"
          disabled={pending || blockedReason !== null}
          onClick={() => void start()}
        >
          {pageOpened ? "Open the page again" : "Sign in"}
        </Button>
      </span>
      {pageOpened ? <span>Finish signing in in your browser.</span> : null}
    </span>
  );
}
