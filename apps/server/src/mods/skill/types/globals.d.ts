// What a mod's worker has globally: the JSX factory `h`, `Fragment`, the element
// names, `console` (which writes to the mod's log) and the JSX namespace with
// the props each element takes. Kept apart from synara.d.ts so code that only
// needs the mod types does not get these globals.

import type {
  BadgeProps,
  BoxProps,
  ButtonProps,
  CodeProps,
  EmptyProps,
  HeadingProps,
  IconProps,
  InputProps,
  LinkProps,
  ListProps,
  MarkdownProps,
  ModElement,
  ModNode,
  RowProps,
  SectionProps,
  SwitchProps,
  TextProps,
  WithChildren,
} from "./synara";

declare global {
  /** The JSX factory; Synara defines it for every mod. */
  function h(
    type: string,
    props: Record<string, unknown> | null,
    ...children: ModNode[]
  ): ModElement;
  const Fragment: "Fragment";
  /** Writes to the mod's log (Settings → Mods, synara_mod_logs). */
  const console: {
    log(...values: unknown[]): void;
    info(...values: unknown[]): void;
    debug(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
  };
  // The elements are globals as well as exports of "synara"; importing them is optional.
  const Box: "Box";
  const Text: "Text";
  const Heading: "Heading";
  const Section: "Section";
  const List: "List";
  const Row: "Row";
  const Button: "Button";
  const Icon: "Icon";
  const Badge: "Badge";
  const Markdown: "Markdown";
  const Code: "Code";
  const Link: "Link";
  const Divider: "Divider";
  const Spinner: "Spinner";
  const Empty: "Empty";
  const Input: "Input";
  const Switch: "Switch";

  namespace JSX {
    type Element = ModElement;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicAttributes {
      key?: string | number;
    }
    interface IntrinsicElements {
      Fragment: WithChildren;
      Box: BoxProps;
      Text: TextProps;
      Heading: HeadingProps;
      Section: SectionProps;
      List: ListProps;
      Row: RowProps;
      Button: ButtonProps;
      Icon: IconProps;
      Badge: BadgeProps;
      Markdown: MarkdownProps;
      Code: CodeProps;
      Link: LinkProps;
      Divider: {};
      Spinner: {};
      Empty: EmptyProps;
      Input: InputProps;
      Switch: SwitchProps;
    }
  }
}

export {};
