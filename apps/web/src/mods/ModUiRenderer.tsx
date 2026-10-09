// FILE: ModUiRenderer.tsx
// Purpose: Draws a tree a mod returned from `ui.render` with Synara's own
//          components. The vocabulary is closed: props map to fixed classes and
//          the text sizes the person chose in Settings; unknown elements show a notice.
// Layer: Web mods UI

import type { ModUiTree, ModViewSite } from "@synara/contracts";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { SidebarSectionLabel } from "~/components/SidebarListSection";
import { ChatHeaderIconButton } from "~/components/chat/chatHeaderControls";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { CentralIcon } from "~/lib/central-icons";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_GAP_CLASS_NAME,
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_PADDING_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  SIDEBAR_ROW_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";

export interface ModUiElement {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: ReadonlyArray<ModUiNode>;
}
export type ModUiNode = ModUiElement | string;

/**
 * Sends a `{ $handler }` reference back to the mod with what happened. Resolves
 * true once the mod handled it, false when it failed (the host shows why).
 */
export type ModUiDispatch = (handler: unknown, payload: unknown) => Promise<boolean>;

/** The site a tree is drawn in; elements match that place's own controls. */
export const ModUiSiteContext = createContext<ModViewSite | null>(null);

const INPUT_CHANGE_DEBOUNCE_MS = 300;

const GAP_CLASS_NAMES: Record<number, string> = {
  0: "gap-0",
  1: "gap-1",
  2: "gap-2",
  3: "gap-3",
  4: "gap-4",
  6: "gap-6",
};
const PADDING_CLASS_NAMES: Record<number, string> = {
  0: "p-0",
  1: "p-1",
  2: "p-2",
  3: "p-3",
  4: "p-4",
  6: "p-6",
};
const PADDING_X_CLASS_NAMES: Record<number, string> = {
  0: "px-0",
  1: "px-1",
  2: "px-2",
  3: "px-3",
  4: "px-4",
  6: "px-6",
};
const PADDING_Y_CLASS_NAMES: Record<number, string> = {
  0: "py-0",
  1: "py-1",
  2: "py-2",
  3: "py-3",
  4: "py-4",
  6: "py-6",
};
const ALIGN_CLASS_NAMES: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};
const JUSTIFY_CLASS_NAMES: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
};
const TONE_CLASS_NAMES: Record<string, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-info-foreground",
};
const SIZE_CLASS_NAMES: Record<string, string> = {
  xs: "text-ui-xs",
  sm: "text-ui-sm",
  md: "text-ui",
  lg: "text-ui-lg",
};
const WEIGHT_CLASS_NAMES: Record<string, string> = {
  normal: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
};
const BUTTON_VARIANTS = new Set(["default", "outline", "ghost", "secondary", "destructive"]);
const BADGE_VARIANTS = new Set(["outline", "secondary", "info", "success", "warning", "error"]);

function stringProp(props: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = props[name];
  return typeof value === "string" ? value : undefined;
}

function pick(map: Record<string | number, string>, value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? map[value] : undefined;
}

function isHandler(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly $handler?: unknown }).$handler === "string"
  );
}

function asNode(value: unknown): ModUiNode | null {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ModUiElement).type === "string"
  ) {
    const element = value as Partial<ModUiElement>;
    return {
      type: element.type as string,
      props: element.props !== null && typeof element.props === "object" ? element.props : {},
      children: Array.isArray(element.children) ? element.children : [],
    };
  }
  return null;
}

/** A child's React key: the mod's `key` prop when it set one, its position otherwise. */
function childKey(node: ModUiNode, position: number): string {
  if (typeof node !== "string") {
    const key = node.props.key;
    if (typeof key === "string" || typeof key === "number") return `k:${key}`;
  }
  return `p:${position}`;
}

function textOf(children: ReadonlyArray<ModUiNode>): string {
  return children
    .map((child) => (typeof child === "string" ? child : textOf(child.children)))
    .join("");
}

function ModUiChildren(props: { nodes: ReadonlyArray<ModUiNode>; dispatch: ModUiDispatch }) {
  return (
    <>
      {props.nodes.map((node, position) => (
        // A child without its own `key` falls back to its position, as React itself would.
        // oxlint-disable-next-line no-array-index-key
        <ModUiNodeView key={childKey(node, position)} node={node} dispatch={props.dispatch} />
      ))}
    </>
  );
}

function ModUiInput(props: { element: ModUiElement; dispatch: ModUiDispatch }) {
  const { element, dispatch } = props;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const onChange = element.props.onChange;
  const onSubmit = element.props.onSubmit;
  return (
    <Input
      size="sm"
      className="min-w-0 flex-1"
      placeholder={stringProp(element.props, "placeholder")}
      defaultValue={stringProp(element.props, "defaultValue") ?? stringProp(element.props, "value")}
      aria-label={stringProp(element.props, "label") ?? stringProp(element.props, "placeholder")}
      aria-busy={pending || undefined}
      onChange={(event) => {
        if (!isHandler(onChange)) return;
        const value = event.currentTarget.value;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => dispatch(onChange, value), INPUT_CHANGE_DEBOUNCE_MS);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        // A band sits inside the composer's form: Enter must not also send the draft.
        event.preventDefault();
        event.stopPropagation();
        if (!isHandler(onSubmit) || pending) return;
        const field = event.currentTarget;
        setPending(true);
        void dispatch(onSubmit, field.value).then((handled) => {
          setPending(false);
          // Ready for the next entry; a mod that shows the saved value redraws with it.
          if (handled) field.value = "";
        });
      }}
    />
  );
}

function ModUiSwitch(props: { element: ModUiElement; dispatch: ModUiDispatch }) {
  const { element, dispatch } = props;
  const checkedProp = element.props.checked === true;
  // Shows the flip at once; the mod's next render settles the real value.
  const [checked, setChecked] = useState(checkedProp);
  useEffect(() => setChecked(checkedProp), [checkedProp]);
  const label = stringProp(element.props, "label");
  const control = (
    <Switch
      checked={checked}
      disabled={element.props.disabled === true}
      aria-label={label}
      onCheckedChange={(next) => {
        setChecked(Boolean(next));
        if (!isHandler(element.props.onChange)) return;
        void dispatch(element.props.onChange, Boolean(next)).then((handled) => {
          // The mod never took the change, so show the value it still has.
          if (!handled) setChecked(checkedProp);
        });
      }}
    />
  );
  if (!label) return control;
  return (
    <label className="flex items-center justify-between gap-3 text-ui">
      <span className="min-w-0 truncate">{label}</span>
      {control}
    </label>
  );
}

function ModUiButton(props: {
  element: ModUiElement;
  dispatch: ModUiDispatch;
  children: ReactNode;
}) {
  const { element, dispatch } = props;
  const p = element.props;
  const site = useContext(ModUiSiteContext);
  const [pending, setPending] = useState(false);
  const icon = stringProp(p, "icon");
  const label = stringProp(p, "label");
  const hasChildren = element.children.length > 0;
  // An icon-only button still needs a name for screen readers and its tooltip.
  const name = label ?? (textOf(element.children) || icon);
  const onPress = isHandler(p.onPress)
    ? () => {
        // A handler can take seconds; a second press would run it again.
        if (pending) return;
        setPending(true);
        void dispatch(p.onPress, null).then(() => setPending(false));
      }
    : undefined;
  const disabled = p.disabled === true || !onPress || pending;

  if (site === "header" && icon) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ChatHeaderIconButton
              type="button"
              tone="surface"
              label={name ?? ""}
              disabled={disabled}
              aria-busy={pending || undefined}
              onClick={onPress}
            />
          }
        >
          <CentralIcon name={icon} className="size-4 shrink-0" />
        </TooltipTrigger>
        {name ? <TooltipPopup side="bottom">{name}</TooltipPopup> : null}
      </Tooltip>
    );
  }

  const variant =
    typeof p.variant === "string" && BUTTON_VARIANTS.has(p.variant)
      ? p.variant
      : site === "header"
        ? "ghost"
        : "outline";
  const iconOnly = !hasChildren && icon !== undefined && label === undefined;
  return (
    <Button
      size={iconOnly ? "icon-xs" : "xs"}
      variant={variant as "default" | "outline" | "ghost" | "secondary" | "destructive"}
      className={cn(site === "header" && "max-w-40")}
      disabled={disabled}
      aria-label={name}
      aria-busy={pending || undefined}
      title={name}
      onClick={onPress}
    >
      {pending && !icon ? <Spinner className="size-3.5" /> : null}
      {icon ? (
        pending ? (
          <Spinner className="size-3.5" />
        ) : (
          <CentralIcon name={icon} className="size-3.5" />
        )
      ) : null}
      {iconOnly ? null : hasChildren ? (
        props.children
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </Button>
  );
}

function ModUiNodeView(props: { node: ModUiNode; dispatch: ModUiDispatch }): ReactNode {
  const { node, dispatch } = props;
  if (typeof node === "string") return node;
  const element = node;
  const p = element.props;
  const children = <ModUiChildren nodes={element.children} dispatch={dispatch} />;
  const onPress = isHandler(p.onPress) ? () => void dispatch(p.onPress, null) : undefined;

  switch (element.type) {
    case "Fragment":
      return children;
    case "Box":
      return (
        <div
          className={cn(
            "flex min-w-0",
            p.direction === "row" ? "flex-row" : "flex-col",
            pick(GAP_CLASS_NAMES, p.gap),
            pick(PADDING_CLASS_NAMES, p.padding),
            pick(PADDING_X_CLASS_NAMES, p.paddingX),
            pick(PADDING_Y_CLASS_NAMES, p.paddingY),
            pick(ALIGN_CLASS_NAMES, p.align),
            pick(JUSTIFY_CLASS_NAMES, p.justify),
            p.grow === true && "flex-1",
            p.wrap === true && "flex-wrap",
            // A column taller than its space scrolls; it must not squash its children
            // (headings to nothing, code to one line). A row may shrink them to truncate.
            p.direction !== "row" && "[&>*]:shrink-0",
            p.border === true && "rounded-md border",
            p.scroll === true && "min-h-0 overflow-y-auto",
          )}
        >
          {children}
        </div>
      );
    case "Text":
      return (
        <span
          className={cn(
            pick(SIZE_CLASS_NAMES, p.size) ?? "text-ui",
            pick(TONE_CLASS_NAMES, p.tone),
            pick(WEIGHT_CLASS_NAMES, p.weight),
            p.mono === true && "font-mono",
            p.italic === true && "italic",
            // Only truncated text may shrink below its longest word; other text wraps between words.
            p.truncate === true ? "min-w-0 truncate" : "break-words",
            p.block === true && "block",
          )}
        >
          {children}
        </span>
      );
    case "Heading":
      return (
        <h3
          className={cn(
            "min-w-0 truncate font-medium text-foreground",
            p.size === "sm" ? "text-ui" : "text-ui-lg",
          )}
        >
          {children}
        </h3>
      );
    case "Section":
      return (
        <section className="flex min-w-0 flex-col gap-0.5 [&>*]:shrink-0">
          {stringProp(p, "title") ? (
            <SidebarSectionLabel
              label={stringProp(p, "title") ?? ""}
              className="px-2 pt-2 pb-0.5"
            />
          ) : null}
          {children}
        </section>
      );
    case "List":
      return <div className="flex min-w-0 flex-col gap-0.5 [&>*]:shrink-0">{children}</div>;
    case "Row": {
      const icon = stringProp(p, "icon");
      const meta = stringProp(p, "meta");
      // `title` is the row's text; children follow it (a badge, a count) or are the text.
      const title = stringProp(p, "title");
      const tooltip = title ?? textOf(element.children);
      const className = cn(
        "flex w-full min-w-0 items-center text-left",
        SIDEBAR_ROW_HEIGHT_CLASS_NAME,
        SIDEBAR_ROW_RADIUS_CLASS_NAME,
        SIDEBAR_ROW_PADDING_CLASS_NAME,
        SIDEBAR_ROW_GAP_CLASS_NAME,
        SIDEBAR_ROW_TEXT_CLASS_NAME,
        p.active === true ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
        onPress && SIDEBAR_ROW_FOCUS_CLASS_NAME,
        onPress && p.active !== true && SIDEBAR_ROW_HOVER_CLASS_NAME,
      );
      const content = (
        <>
          {icon ? <CentralIcon name={icon} className="size-4 shrink-0 opacity-80" /> : null}
          {title !== undefined ? (
            <>
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {element.children.length > 0 ? (
                <span className="flex shrink-0 items-center gap-1">{children}</span>
              ) : null}
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate">{children}</span>
          )}
          {meta ? <span className="shrink-0 text-ui-xs text-muted-foreground">{meta}</span> : null}
        </>
      );
      const current = p.active === true ? "true" : undefined;
      return onPress ? (
        <button
          type="button"
          className={className}
          title={tooltip || undefined}
          aria-current={current}
          onClick={onPress}
        >
          {content}
        </button>
      ) : (
        <div className={className} title={tooltip || undefined} aria-current={current}>
          {content}
        </div>
      );
    }
    case "Button":
      return (
        <ModUiButton element={element} dispatch={dispatch}>
          {children}
        </ModUiButton>
      );
    case "Icon": {
      const name = stringProp(p, "name");
      if (!name) return null;
      return (
        <CentralIcon
          name={name}
          label={stringProp(p, "label")}
          className={cn(
            "shrink-0",
            p.size === "md" ? "size-4" : "size-3.5",
            pick(TONE_CLASS_NAMES, p.tone),
          )}
        />
      );
    }
    case "Badge": {
      const variant = typeof p.tone === "string" && BADGE_VARIANTS.has(p.tone) ? p.tone : "outline";
      return (
        <Badge variant={variant as "outline"} size="sm">
          {children}
        </Badge>
      );
    }
    case "Markdown":
      return (
        <ChatMarkdown
          text={stringProp(p, "text") ?? textOf(element.children)}
          cwd={undefined}
          className="text-ui"
        />
      );
    case "Code":
      return (
        <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-ui-xs whitespace-pre">
          <code>{stringProp(p, "text") ?? textOf(element.children)}</code>
        </pre>
      );
    case "Link": {
      const href = stringProp(p, "href");
      const opensUrl = href !== undefined && /^https?:\/\//iu.test(href);
      return (
        <button
          type="button"
          className="rounded-sm text-info-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline disabled:opacity-60"
          disabled={!opensUrl && !onPress}
          title={opensUrl ? href : undefined}
          onClick={() => {
            if (opensUrl) openExternalLink(href);
            onPress?.();
          }}
        >
          {element.children.length > 0 ? children : href}
        </button>
      );
    }
    case "Divider":
      return <Separator className="my-1" />;
    case "Spinner":
      return <Spinner className="size-4 text-muted-foreground" />;
    case "Empty":
      return (
        <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
          {stringProp(p, "title") ? (
            <span className="text-ui font-medium text-foreground">{stringProp(p, "title")}</span>
          ) : null}
          {stringProp(p, "description") ? (
            <span className="text-ui-sm text-muted-foreground">{stringProp(p, "description")}</span>
          ) : null}
          {children}
        </div>
      );
    case "Input":
      // A new value from the mod (a saved note) replaces what the field shows.
      return (
        <ModUiInput
          key={String(stringProp(p, "defaultValue") ?? stringProp(p, "value") ?? "")}
          element={element}
          dispatch={dispatch}
        />
      );
    case "Switch":
      return <ModUiSwitch element={element} dispatch={dispatch} />;
    default:
      return (
        <span className="rounded border border-dashed border-warning/50 px-1 text-ui-xs text-warning">
          Unknown element “{element.type}”
        </span>
      );
  }
}

/** Draws a whole tree; a value that is not a tree draws nothing. */
export function ModUiRenderer(props: {
  tree: ModUiTree | null;
  dispatch: ModUiDispatch;
  site?: ModViewSite | undefined;
}) {
  const node = asNode(props.tree);
  if (node === null) return null;
  return (
    <ModUiSiteContext.Provider value={props.site ?? null}>
      <ModUiNodeView node={node} dispatch={props.dispatch} />
    </ModUiSiteContext.Provider>
  );
}
