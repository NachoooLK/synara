// The "synara" module a mod imports: its hooks, events, the `$` object and the
// elements its views draw with. The server's own mod code imports these types
// too, so this file is the single description of the mod interface.

// ── Data ─────────────────────────────────────────────────────────────

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
  /** "project" for a folder in the sidebar; other kinds are Synara's own containers. */
  readonly kind: string;
  readonly isPinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ModToastTone = "info" | "success" | "warning" | "error";

export interface ModCommandDefinition {
  /** Lowercase words joined by dashes; unique within the mod. */
  readonly name: string;
  /** What the command palette shows. */
  readonly title: string;
  readonly description?: string;
}

/** A tool an MCP server offers. */
export interface ModMcpTool {
  readonly name: string;
  readonly description: string | null;
  readonly inputSchema: unknown;
}

/** What an MCP tool returned, as the MCP spec describes it. */
export interface ModMcpCallResult {
  /** Content parts, usually `{ type: "text", text }`. */
  readonly content: ReadonlyArray<
    { readonly type: string; readonly text?: string } & Record<string, unknown>
  >;
  /** The tool's structured result, when the server sends one. */
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

// ── Views ────────────────────────────────────────────────────────────

/** Where a view is drawn: the sidebar panel, a dock tab, a band above the composer, the thread header. */
export type ModViewSite = "sidebar" | "dock" | "band" | "header";

export interface ModViewDefinition {
  /** Lowercase words joined by dashes; unique within the mod. */
  readonly id: string;
  readonly site: ModViewSite;
  readonly title: string;
  /** A Central icon name, such as "calendar-1" or "pull-request". */
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

// ── Events ───────────────────────────────────────────────────────────

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
export type Register = (
  on: ModOn,
  options: Readonly<Record<string, unknown>>,
) => void | Promise<void>;

// ── The `$` object ───────────────────────────────────────────────────

export interface ModLog {
  (message: string): Promise<void>;
  readonly info: (message: string) => Promise<void>;
  readonly warn: (message: string) => Promise<void>;
  readonly error: (message: string) => Promise<void>;
}

/** Everything a mod can reach. Every call crosses into Synara and resolves when it is done. */
export interface ModApi {
  readonly mod: { readonly id: string; readonly version: string };
  /** Also where console.log, console.warn and console.error go. */
  readonly log: ModLog;
  readonly ui: {
    /** A short notice in every open window. */
    readonly toast: (text: string, options?: { readonly tone?: ModToastTone }) => Promise<void>;
    /** The mod's status line in Settings → Mods; `undefined` clears it. */
    readonly status: (text: string | undefined) => Promise<void>;
    /** Adds a view (or updates it); answer it with an `on("ui.render", { view: id }, …)` hook. */
    readonly view: (view: ModViewDefinition) => Promise<void>;
    readonly removeView: (viewId: string) => Promise<void>;
    /** Draws a view again (every view of the mod without an id). `$.state.set` does this for you. */
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
    /** Newest first; archived threads only when asked. */
    readonly list: (options?: {
      readonly projectId?: string;
      readonly includeArchived?: boolean;
      /** Defaults to 200, at most 1000. */
      readonly limit?: number;
    }) => Promise<ModThread[]>;
    readonly get: (threadId: string) => Promise<ModThread | null>;
  };
  readonly projects: {
    readonly list: () => Promise<ModProject[]>;
  };
  /**
   * The MCP servers the mod's mod.json declares under "mcpServers", by name.
   * Synara starts a local server on first use and stops it with the mod.
   */
  readonly mcp: {
    readonly tools: (server: string) => Promise<ModMcpTool[]>;
    readonly call: (
      server: string,
      tool: string,
      args?: Record<string, unknown>,
    ) => Promise<ModMcpCallResult>;
    /** Calls a tool and returns its structured result, or its text parsed as JSON; throws on a tool error. */
    readonly json: <T = unknown>(
      server: string,
      tool: string,
      args?: Record<string, unknown>,
    ) => Promise<T>;
  };
  /** Values Synara holds while it runs; they survive a reload of the mod. Setting one redraws the mod's views. */
  readonly state: {
    readonly get: <T = unknown>(key: string) => Promise<T | undefined>;
    /** `undefined` deletes the value. */
    readonly set: (key: string, value: unknown) => Promise<void>;
  };
  /** Values saved to disk (1 MB per mod); they survive restarts. Plain JSON only. */
  readonly store: {
    readonly get: <T = unknown>(key: string) => Promise<T | undefined>;
    readonly set: (key: string, value: unknown) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
    readonly keys: () => Promise<string[]>;
  };
}

// ── Elements ─────────────────────────────────────────────────────────
// Views are trees of these elements, drawn with Synara's own components and
// the text size the person chose. Props take fixed values, not CSS.

export type ModTone = "default" | "muted" | "success" | "warning" | "danger" | "info";
export type ModSpace = 0 | 1 | 2 | 3 | 4 | 6;

export interface WithChildren {
  readonly children?: ModNode;
}

export interface BoxProps extends WithChildren {
  /** Defaults to "column". */
  readonly direction?: "row" | "column";
  readonly gap?: ModSpace;
  readonly padding?: ModSpace;
  readonly paddingX?: ModSpace;
  readonly paddingY?: ModSpace;
  readonly align?: "start" | "center" | "end" | "stretch";
  readonly justify?: "start" | "center" | "end" | "between";
  /** Takes the free space of its parent row or column. */
  readonly grow?: boolean;
  readonly wrap?: boolean;
  /** A rounded border around the box. */
  readonly border?: boolean;
  /** Scrolls its content vertically when it is taller than the box. */
  readonly scroll?: boolean;
}

export interface TextProps extends WithChildren {
  /** Relative to the person's text size; defaults to "md". */
  readonly size?: "xs" | "sm" | "md" | "lg";
  readonly tone?: ModTone;
  readonly weight?: "normal" | "medium" | "semibold";
  readonly mono?: boolean;
  readonly italic?: boolean;
  /** One line with an ellipsis instead of wrapping. */
  readonly truncate?: boolean;
  /** Its own line instead of inline. */
  readonly block?: boolean;
}

export interface HeadingProps extends WithChildren {
  readonly size?: "sm" | "md";
}

/** A titled group of rows, like "Projects" and "Chats" in the sidebar. */
export interface SectionProps extends WithChildren {
  readonly title?: string;
}

export interface ListProps extends WithChildren {}

/** A sidebar row: icon, label, a muted meta text on the right. */
export interface RowProps extends WithChildren {
  readonly icon?: string;
  readonly meta?: string;
  /** The row's text; children follow it (a badge, a count). Without it, the children are the text. */
  readonly title?: string;
  /** Marks the row selected, like the open thread in the sidebar. */
  readonly active?: boolean;
  readonly onPress?: () => unknown;
}

export interface ButtonProps extends WithChildren {
  readonly icon?: string;
  /** Accessible name and tooltip; the visible text when there are no children. */
  readonly label?: string;
  /** Defaults to "outline". */
  readonly variant?: "default" | "outline" | "ghost" | "secondary" | "destructive";
  readonly disabled?: boolean;
  readonly onPress?: () => unknown;
}

export interface IconProps {
  readonly name: string;
  readonly size?: "sm" | "md";
  readonly tone?: ModTone;
  readonly label?: string;
}

export interface BadgeProps extends WithChildren {
  readonly tone?: "outline" | "secondary" | "info" | "success" | "warning" | "error";
}

/** Model-style text: headings, lists, links, code. */
export interface MarkdownProps extends WithChildren {
  readonly text?: string;
}

/** A monospace block, scrolled when long. */
export interface CodeProps extends WithChildren {
  readonly text?: string;
}

export interface LinkProps extends WithChildren {
  /** An http(s) address opened in the browser. */
  readonly href?: string;
  readonly onPress?: () => unknown;
}

export interface EmptyProps extends WithChildren {
  readonly title?: string;
  readonly description?: string;
}

/** A text field. Typing is not sent on every key: use onSubmit (Enter) or onChange (after a pause). */
export interface InputProps {
  readonly placeholder?: string;
  readonly defaultValue?: string;
  readonly label?: string;
  readonly onChange?: (value: string) => unknown;
  readonly onSubmit?: (value: string) => unknown;
}

export interface SwitchProps {
  readonly checked?: boolean;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly onChange?: (checked: boolean) => unknown;
}

export declare const Box: "Box";
export declare const Text: "Text";
export declare const Heading: "Heading";
export declare const Section: "Section";
export declare const List: "List";
export declare const Row: "Row";
export declare const Button: "Button";
export declare const Icon: "Icon";
export declare const Badge: "Badge";
export declare const Markdown: "Markdown";
export declare const Code: "Code";
export declare const Link: "Link";
export declare const Divider: "Divider";
export declare const Spinner: "Spinner";
export declare const Empty: "Empty";
export declare const Input: "Input";
export declare const Switch: "Switch";
