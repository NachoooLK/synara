// FILE: modMcpSignIn.ts
// Purpose: Starts the sign-in to one of a mod's MCP servers: asks the server for the
//          sign-in page and opens it in the person's browser. The server keeps the
//          token, and its next snapshot says the mod is signed in.
// Layer: Web mods logic (shared by the view host and Settings → Mods)

import { toastManager } from "~/components/ui/toast";
import { openExternalLink } from "~/lib/linkChips";
import { ensureNativeApi } from "~/nativeApi";

/** Whether the sign-in page was opened; a sign-in that could not start is shown as a toast. */
export async function startModMcpSignIn(modId: string, server: string): Promise<boolean> {
  try {
    const { url } = await ensureNativeApi().mods.mcpSignIn({ id: modId, server });
    // The address comes from the server the mod names, so only a web page is opened.
    if (!/^https?:\/\//i.test(url)) throw new Error("The sign-in page is not a web address.");
    openExternalLink(url);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The server did not answer.";
    toastManager.add({
      type: "error",
      title: "Could not start the sign-in",
      description: `${message} (from the ${modId} mod)`,
    });
    return false;
  }
}
