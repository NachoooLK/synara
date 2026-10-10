import { Schema } from "effect";
import {
  ModsSnapshot,
  ModsPullRequestListResult,
  type NativeApi,
  type ModsPullRequestListInput,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useModsStore } from "~/mods/modsStore";
import { useCodeReviewSources } from "./useCodeReviewSources";

const source = { kind: "mod" as const, modId: "demo", sourceId: "reviews" };
const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
  useModsStore.setState({ snapshot: null });
  Reflect.deleteProperty(window, "nativeApi");
});
function Body() {
  const result = useCodeReviewSources({ state: "open", sort: "updated" });
  return (
    <div>
      {result.rows.map((row) => (
        <span key={row.item.title}>{row.item.title}</span>
      ))}
      <button onClick={() => void result.refresh()}>Refresh</button>
      {result.pagination.map((next) => (
        <button key={next.key} onClick={() => void next.loadMore()}>
          Load more
        </button>
      ))}
    </div>
  );
}
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(!open)}>Open page</button>
      {open ? <Body /> : null}
    </>
  );
}
it("fetches on demand and follows opaque pagination", async () => {
  const calls: ModsPullRequestListInput[] = [];
  window.nativeApi = {
    githubInbox: {
      list: async () => ({
        items: [],
        errors: [],
        viewer: null,
        repositoryBatches: [],
        rateLimit: null,
        reviewRequestedCount: 0,
        reviewRequestedCountIncomplete: false,
      }),
    },
    mods: {
      pullRequests: {
        list: async (input: ModsPullRequestListInput) => {
          calls.push(input);
          return Schema.decodeUnknownSync(ModsPullRequestListResult)({
            source,
            revision: "current",
            nextCursor: input.cursor ? null : "next/A-α",
            items: [
              {
                repository: "Team/Repo",
                itemId: input.cursor ? "second" : "first",
                title: input.cursor ? "Second item" : "First item",
                url: "https://reviews.example.test/42",
                state: "open",
                projectContexts: [],
                isPinned: false,
              },
            ],
          });
        },
      },
    },
  } as unknown as NativeApi;
  useModsStore
    .getState()
    .setSnapshot(
      Schema.decodeUnknownSync(ModsSnapshot)({
        modsDir: "/mods",
        mods: [
          {
            id: "demo",
            version: "1",
            description: null,
            path: "/mods/demo",
            enabled: true,
            status: "running",
            error: null,
            hooks: [],
            commands: [],
            tools: [],
            views: [],
            mcpServers: [],
            mcpSignIns: [],
            permissions: [],
            reloadsOnChange: false,
            statusText: null,
            loadedAt: null,
            pullRequestSources: [
              { source, title: "Reviews", revision: "current", capabilities: {} },
            ],
          },
        ],
      }),
    );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  await render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: "Open page" }).click();
  await expect.element(page.getByText("First item")).toBeVisible();
  expect(calls).toHaveLength(1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect.element(page.getByText("Second item")).toBeVisible();
  expect(calls[2]!.cursor).toBe("next/A-α");
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  vi.useRealTimers();
  expect(calls).toHaveLength(3);
  // Resetting authenticated reads must discard extra pages too, even with the same revision.
  await client.resetQueries({ queryKey: ["mod-pull-requests", "demo", "reviews"] });
  await expect.element(page.getByText("First item")).toBeVisible();
  await expect.element(page.getByText("Second item")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open page" }).click();
});
