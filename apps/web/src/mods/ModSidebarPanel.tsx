// FILE: ModSidebarPanel.tsx
// Purpose: The sidebar panel while a mod's sidebar view is selected in the rail:
//          the view's title, then the view the mod draws.
// Layer: Web mods UI

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";

import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { SidebarPanelTitle } from "~/components/SidebarPanelTitle";
import { Button } from "~/components/ui/button";

import { ModViewHost } from "./ModViewHost";
import { useModsStore } from "./modsStore";
import { type ModSidebarViewRef, useModSidebarStore } from "./modSidebarStore";

/** Shown in place of the view while its mod is off, crashed, or no longer draws it. */
function ModSidebarViewUnavailable({ modId }: { modId: string }) {
  const navigate = useNavigate();
  const clearView = useModSidebarStore((state) => state.clear);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarPanelTitle title="Mod view" />
      <PanelStateMessage fill="flex">
        <div className="flex flex-col items-center gap-3">
          <p>The {modId} mod is not running or no longer has this view.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings", search: { section: "mods" } })}
            >
              Open Mods settings
            </Button>
            {/* Clearing the view gives the panel back to the chats list. */}
            <Button size="xs" variant="ghost" onClick={clearView}>
              Back to chats
            </Button>
          </div>
        </div>
      </PanelStateMessage>
    </div>
  );
}

export function ModSidebarPanel(props: {
  view: ModSidebarViewRef;
  threadId: ThreadId | null;
  projectId: string | null;
}) {
  const { view } = props;
  const title = useModsStore(
    (state) =>
      state.snapshot?.mods
        .find((mod) => mod.id === view.modId)
        ?.views.find((candidate) => candidate.id === view.viewId)?.title ?? null,
  );
  if (title === null) return <ModSidebarViewUnavailable modId={view.modId} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarPanelTitle title={title} />
      <ModViewHost
        modId={view.modId}
        viewId={view.viewId}
        context={{ threadId: props.threadId, projectId: props.projectId }}
        site="sidebar"
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
      />
    </div>
  );
}
