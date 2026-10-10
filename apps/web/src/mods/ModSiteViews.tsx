// FILE: ModSiteViews.tsx
// Purpose: The views running mods draw above the composer (band) and in the
//          thread header (header). Each draws quietly: nothing when the mod
//          returns nothing or fails.
// Layer: Web mods UI (Beta-only; nothing where mods are off)

import type { ModViewSite, ThreadId } from "@synara/contracts";
import { useMemo } from "react";

import { MODS_ON } from "~/betaFeatures";
import { ComposerStackedPanel } from "~/components/chat/ComposerStackedPanel";

import { ModViewHost } from "./ModViewHost";
import { useModsStore } from "./modsStore";

interface SiteView {
  readonly modId: string;
  readonly viewId: string;
  readonly title: string;
}

function useSiteViews(site: ModViewSite): readonly SiteView[] {
  const snapshot = useModsStore((state) => state.snapshot);
  return useMemo(() => {
    if (!MODS_ON || snapshot === null) return [];
    return snapshot.mods
      .filter((mod) => mod.status === "running")
      .flatMap((mod) =>
        mod.views
          .filter((view) => view.site === site)
          .map((view) => ({ modId: mod.id, viewId: view.id, title: view.title })),
      );
  }, [snapshot, site]);
}

export function ModComposerBands(props: { threadId: ThreadId; projectId: string | null }) {
  const views = useSiteViews("band");
  return (
    <>
      {views.map((view) => (
        <ModViewHost
          key={`${view.modId}:${view.viewId}`}
          modId={view.modId}
          viewId={view.viewId}
          context={{ threadId: props.threadId, projectId: props.projectId }}
          site="band"
          quiet
          className="min-w-0 px-3 py-1.5"
          // Nothing on a band says where it comes from; its name and mod are one hover away.
          frame={(content) => (
            <ComposerStackedPanel>
              <div
                role="group"
                aria-label={`${view.title}, from the ${view.modId} mod`}
                title={`${view.title} · ${view.modId} mod`}
              >
                {content}
              </div>
            </ComposerStackedPanel>
          )}
        />
      ))}
    </>
  );
}

export function ModHeaderActions(props: { threadId: ThreadId; projectId: string | null }) {
  const views = useSiteViews("header");
  if (views.length === 0) return null;
  return (
    <>
      {views.map((view) => (
        <ModViewHost
          key={`${view.modId}:${view.viewId}`}
          modId={view.modId}
          viewId={view.viewId}
          context={{ threadId: props.threadId, projectId: props.projectId }}
          site="header"
          quiet
          // A mod's header controls may not push the thread title out of a narrow header.
          className="flex max-w-72 shrink-0 items-center gap-1 overflow-hidden"
        />
      ))}
    </>
  );
}
