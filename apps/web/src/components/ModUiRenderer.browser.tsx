import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { ModUiRenderer } from "~/mods/ModUiRenderer";

afterEach(() => cleanup());

describe("ModUiRenderer", () => {
  it("submits a mod's field on Enter without submitting the composer form around it", async () => {
    const dispatch = vi.fn(async () => true);
    const onFormSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    await render(
      <form onSubmit={(event) => onFormSubmit(event.nativeEvent as SubmitEvent)}>
        <ModUiRenderer
          tree={{
            type: "Input",
            props: { label: "Note", onSubmit: { $handler: "r1.0" } },
            children: [],
          }}
          dispatch={dispatch}
        />
        <button type="submit">Send</button>
      </form>,
    );
    const field = page.getByRole("textbox", { name: "Note" });
    await field.fill("remember this");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    expect(dispatch).toHaveBeenCalledWith({ $handler: "r1.0" }, "remember this");
    expect(onFormSubmit).not.toHaveBeenCalled();
    // Ready for the next entry once the mod took this one.
    await expect.element(field).toHaveValue("");
  });

  it("shows a row's title as its text, with its children after it", async () => {
    await render(
      <ModUiRenderer
        tree={{
          type: "Row",
          props: { title: "Fix flaky test", meta: "luis" },
          children: [{ type: "Badge", props: { tone: "error" }, children: ["failing"] }],
        }}
        dispatch={async () => true}
      />,
    );
    await expect.element(page.getByText("Fix flaky test")).toBeVisible();
    await expect.element(page.getByText("failing")).toBeVisible();
  });

  it("keeps a column's children at their size when it overflows", async () => {
    await render(
      <div style={{ height: 120, display: "flex", flexDirection: "column" }}>
        <ModUiRenderer
          tree={{
            type: "Box",
            props: { scroll: true },
            children: [
              { type: "Heading", props: {}, children: ["Pull requests"] },
              ...Array.from({ length: 12 }, (_, index) => ({
                type: "Text",
                props: { block: true },
                children: [`line ${index}`],
              })),
            ],
          }}
          dispatch={async () => true}
        />
      </div>,
    );
    const heading = page.getByRole("heading", { name: "Pull requests" });
    await expect.element(heading).toBeVisible();
    expect((heading.element() as HTMLElement).getBoundingClientRect().height).toBeGreaterThan(8);
  });
});
