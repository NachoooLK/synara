// FILE: modApi.ts
// Purpose: The interface a mod is written against: `register(on)`, its events,
//          hook signature and the `$` object every hook receives.
// Layer: Mods SDK. The worker runtime implements it; the mod authoring skill
//        ships it as the mod's type declarations.

/** A thread as a mod sees it: identity, placement and live state, no transcript. */
export interface ModThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly parentThreadId: string | null;
  readonly isPinned: boolean;
  /** The latest turn's state, or null before the first turn. */
  readonly latestTurnState: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ModProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly kind: string;
  readonly isPinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ModToastTone = "info" | "success" | "warning" | "error";

/** Where a view is drawn: the sidebar panel, a dock tab, a band above the composer, the thread header. */
export type ModViewSite = "sidebar" | "dock" | "band" | "header";

export interface ModViewDefinition {
  /** Lowercase words joined by dashes; unique within the mod. */
  readonly id: string;
  readonly site: ModViewSite;
  readonly title: string;
  /** A Central icon name, such as "calendar-1" or "git-pull-request". */
  readonly icon?: string;
  /** Redraw the view on its own when Synara's threads or projects change. */
  readonly refreshOn?: ReadonlyArray<"threads" | "projects">;
}

/** What the window drawing a view knows. */
export interface ModViewContext {
  readonly threadId: string | null;
  readonly projectId: string | null;
}

/** A node of a tree: an element JSX built, text, or nothing. */
export type ModNode = ModElement | string | number | boolean | null | undefined | ModNode[];

export interface ModElement {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<ModNode>;
}

export interface ModCommandDefinition {
  /** Lowercase words joined by dashes; unique within the mod. */
  readonly name: string;
  /** What the command palette shows. */
  readonly title: string;
  readonly description?: string;
}

/** Each event's input (`e`) and the result its chain resolves to. */
export interface ModEvents {
  /** The mod was loaded (at startup, when enabled, and after every reload). */
  readonly "mod.start": { readonly input: Record<string, never>; readonly result: void };
  /** The mod is about to stop (disabled, reloaded or the server is shutting down). */
  readonly "mod.stop": { readonly input: Record<string, never>; readonly result: void };
  /** A window needs one of this mod's views drawn; return a tree, or null for nothing. */
  readonly "ui.render": {
    readonly input: {
      readonly view: string;
      readonly site: ModViewSite;
      readonly context: ModViewContext;
    };
    readonly result: ModNode;
  };
  /** Someone ran one of this mod's commands from the command palette. */
  readonly "command.run": {
    readonly input: { readonly command: string; readonly threadId: string | null };
    /** `text` is shown to the person as a toast. */
    readonly result: { readonly text?: string } | void;
  };
}

export type ModEventName = keyof ModEvents;
export type ModEventInput<E extends ModEventName> = ModEvents[E]["input"];
export type ModEventResult<E extends ModEventName> = ModEvents[E]["result"];

/** Fields of the input to compare; a hook runs only for inputs that match every one. */
export type ModEventMatcher<E extends ModEventName> = {
  readonly [K in keyof ModEventInput<E>]?: ModEventInput<E>[K] | ReadonlyArray<ModEventInput<E>[K]>;
};

/**
 * A hook: `$` reaches Synara, `e` is the event's frozen input and `next(e)` runs
 * the hooks after this one and then Synara's own behaviour. Return without
 * calling `next` to answer for yourself; call `next({ ...e, x })` to change
 * what the rest of the chain sees.
 */
export type ModHook<E extends ModEventName> = (
  $: ModApi,
  e: Readonly<ModEventInput<E>>,
  next: (e?: ModEventInput<E>) => Promise<ModEventResult<E>>,
) => ModEventResult<E> | Promise<ModEventResult<E>>;

export interface ModOn {
  <E extends ModEventName>(event: E, hook: ModHook<E>): void;
  <E extends ModEventName>(event: E, matcher: ModEventMatcher<E>, hook: ModHook<E>): void;
}

/** What a hooks module exports as `register` (or as its default export). */
export type Register = (on: ModOn, options: Readonly<Record<string, unknown>>) => void;

export interface ModLog {
  (message: string): Promise<void>;
  readonly info: (message: string) => Promise<void>;
  readonly warn: (message: string) => Promise<void>;
  readonly error: (message: string) => Promise<void>;
}

/** Everything a mod can reach. Every call crosses into the server and resolves when it is done. */
export interface ModApi {
  readonly mod: { readonly id: string; readonly version: string };
  readonly log: ModLog;
  readonly ui: {
    /** A short notice in every open window. */
    readonly toast: (text: string, options?: { readonly tone?: ModToastTone }) => Promise<void>;
    /** The mod's status line entry; `undefined` clears it. */
    readonly status: (text: string | undefined) => Promise<void>;
    /** Adds a view (or updates it); answer it with an `on("ui.render", { view: id }, …)` hook. */
    readonly view: (view: ModViewDefinition) => Promise<void>;
    readonly removeView: (viewId: string) => Promise<void>;
    /** Draws a view again (all of the mod's views without an id). `$.state.set` does this for you. */
    readonly invalidate: (viewId?: string) => Promise<void>;
    /** Inside a handler (an onPress): opens a thread in the window that pressed. */
    readonly openThread: (threadId: string) => Promise<void>;
    /** Inside a handler: opens an http(s) address in the browser. */
    readonly openUrl: (url: string) => Promise<void>;
    /** Inside a handler: opens one of this mod's dock views next to the thread. */
    readonly openDockView: (viewId: string) => Promise<void>;
  };
  readonly command: {
    /** Adds a command to the palette; answer it with an `on("command.run", { command }, …)` hook. */
    readonly register: (command: ModCommandDefinition) => Promise<void>;
    readonly unregister: (name: string) => Promise<void>;
  };
  readonly threads: {
    readonly list: (options?: {
      readonly projectId?: string;
      readonly includeArchived?: boolean;
      readonly limit?: number;
    }) => Promise<ModThread[]>;
    readonly get: (threadId: string) => Promise<ModThread | null>;
  };
  readonly projects: {
    readonly list: () => Promise<ModProject[]>;
  };
  /** Values held by Synara while it runs; they survive a reload of the mod. */
  readonly state: {
    readonly get: <T = unknown>(key: string) => Promise<T | undefined>;
    readonly set: (key: string, value: unknown) => Promise<void>;
  };
  /** Values saved to disk; they survive restarts. Plain JSON only. */
  readonly store: {
    readonly get: <T = unknown>(key: string) => Promise<T | undefined>;
    readonly set: (key: string, value: unknown) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
    readonly keys: () => Promise<string[]>;
  };
}
