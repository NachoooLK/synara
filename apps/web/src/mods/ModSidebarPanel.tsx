// FILE: ModSidebarPanel.tsx
// Purpose: The sidebar panel while a mod's sidebar view is selected in the rail:
//          the view's title, then the view the mod draws.
// Layer: Web mods UI

import type { ThreadId } from "@synara/contracts";

import { SidebarPanelTitle } from "~/components/SidebarPanelTitle";

import { ModViewHost } from "./ModViewHost";
import { useModsStore } from "./modsStore";
import type { ModSidebarViewRef } from "./modSidebarStore";

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
  if (title === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SidebarPanelTitle title="Mod view" />
        <p className="px-3 py-2 text-ui-sm text-muted-foreground">
          The {view.modId} mod is not running or no longer has this view.
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarPanelTitle title={title} />
      <ModViewHost
        modId={view.modId}
        viewId={view.viewId}
        context={{ threadId: props.threadId, projectId: props.projectId }}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
      />
    </div>
  );
}
