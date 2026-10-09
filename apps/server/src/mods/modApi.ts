// FILE: modApi.ts
// Purpose: The mod interface for server code. The declaration file the authoring
//          skill ships (skill/types/synara.d.ts) is the single source; this
//          module only re-exports it.
// Layer: Mods SDK

export type {
  ModApi,
  ModCommandDefinition,
  ModElement,
  ModEventInput,
  ModEventMatcher,
  ModEventName,
  ModEventResult,
  ModEvents,
  ModHook,
  ModNode,
  ModOn,
  ModProject,
  ModThread,
  ModToastTone,
  ModViewContext,
  ModViewDefinition,
  ModViewSite,
  Register,
} from "./skill/types/synara";
