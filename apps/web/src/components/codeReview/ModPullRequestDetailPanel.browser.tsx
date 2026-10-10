import "../../index.css";
import { Schema } from "effect";
import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  ModsSnapshot,
  ModsPullRequestListResult,
  ModsPullRequestDetailResult,
  type NativeApi,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useModsStore } from "~/mods/modsStore";
import { useStore } from "~/store";
import { GitHubInbox } from "../githubInbox/GitHubInbox";
import { mergeGitHubInboxSearch, type GitHubInboxSearch } from "../githubInbox/githubInbox.logic";

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));
const clients: QueryClient[] = [];
const detailCalls = vi.fn();
const diffCalls = vi.fn();
const refs = ["alpha", "beta"].map((modId) => ({
  kind: "mod" as const,
  modId,
  sourceId: "reviews",
}));
const entries = refs.map((_, index) => ({
  repository: "Team/Repo",
  itemId: index ? "42" : "review/A-α",
  title: index ? "Review B" : "Review A",
  url: "https://reviews.example.test/42",
  state: "open",
  projectContexts: [],
  isPinned: false,
}));
function Harness() {
  const [search, setSearch] = useState<GitHubInboxSearch>({});
  return (
    <div style={{ height: "100vh" }} className="flex">
      <GitHubInbox
        search={search}
        onSearchChange={(patch) => setSearch((current) => mergeGitHubInboxSearch(current, patch))}
      />
    </div>
  );
}
beforeEach(async () => {
  localStorage.clear();
  useStore.setState({ projects: [] });
  detailCalls.mockReset();
  diffCalls.mockReset();
  useModsStore
    .getState()
    .setSnapshot(
      Schema.decodeUnknownSync(ModsSnapshot)({
        modsDir: "/mods",
        mods: refs.map((source) => ({
          id: source.modId,
          version: "1",
          path: `/mods/${source.modId}`,
          description: null,
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
            {
              source,
              title: `${source.modId} reviews`,
              revision: "current",
              capabilities: { diff: source.modId === "alpha" },
            },
          ],
        })),
      }),
    );
  window.nativeApi = {
    server: {
      getSettings: async () => DEFAULT_SERVER_SETTINGS_VIEW,
      updateSettings: async () => DEFAULT_SERVER_SETTINGS_VIEW,
    },
    shell: { openExternal: vi.fn() },
    githubInbox: {
      list: async () => {
        throw Object.assign(new Error("GitHub needs sign-in"), { code: "gh-not-authenticated" });
      },
    },
    mods: {
      pullRequests: {
        list: async (input: { modId: string }) => {
          const index = input.modId === "alpha" ? 0 : 1;
          return Schema.decodeUnknownSync(ModsPullRequestListResult)({
            source: refs[index],
            revision: "current",
            items: [entries[index]],
          });
        },
        detail: async (input: { modId: string; itemId: string }) => {
          detailCalls(input);
          const index = input.modId === "alpha" ? 0 : 1;
          return Schema.decodeUnknownSync(ModsPullRequestDetailResult)({
            ...entries[index],
            source: refs[index],
            revision: "current",
            body: `Description ${input.modId}`,
          });
        },
        diff: async (input: unknown) => {
          diffCalls(input);
          return { patch: "", truncated: false };
        },
      },
    },
  } as unknown as NativeApi;
  await page.viewport(1280, 800);
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  useModsStore.setState({ snapshot: null });
  useStore.setState({ projects: [] });
  Reflect.deleteProperty(window, "nativeApi");
});
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  await render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}
it("shows mod rows without GitHub authentication and opens opaque native detail", async () => {
  await mount();
  await expect
    .element(page.getByText("Review A", { exact: true }), { timeout: 1500 })
    .toBeVisible();
  await expect.element(page.getByText("Review B", { exact: true })).toBeVisible();
  expect(detailCalls).not.toHaveBeenCalled();
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitemradio", { name: "alpha reviews", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Review B", { exact: true })).not.toBeInTheDocument();
  await page.getByText("Review A", { exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Review A" })).toBeVisible();
  expect(detailCalls.mock.calls[0]![0].itemId).toBe("review/A-α");
  expect(diffCalls).not.toHaveBeenCalled();
  await expect.element(page.getByText("Description alpha")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Timeline", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Merge", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await expect.poll(() => diffCalls.mock.calls.length).toBe(1);
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  expect(diffCalls).toHaveBeenCalledTimes(1);
});
it("hides unsupported tabs and preserves narrow list-detail navigation", async () => {
  await page.viewport(620, 800);
  await mount();
  await expect
    .element(page.getByText("Review B", { exact: true }), { timeout: 1500 })
    .toBeVisible();
  await page.getByText("Review B", { exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Review B" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Changes", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Back to code review" }).click();
  await expect.element(page.getByText("Review A", { exact: true })).toBeVisible();
});
