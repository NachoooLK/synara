// Service-aware presentation identities. Mod repository and item IDs stay opaque.
import { Schema } from "effect";
import {
  ModPullRequestSourceRef,
  type PullRequestSourceRef,
  type ModPullRequestIdentity,
  type GitHubInboxListResult,
  type GitHubInboxItem,
  type ModsPullRequestListResult,
  type ModsPullRequestListEntry,
  type GitHubInboxSort,
} from "@synara/contracts";
import type {
  GitHubInboxSearch,
  GitHubInboxSearchPatch,
  GitHubInboxFilters,
} from "../githubInbox/githubInbox.logic";

export function codeReviewSourceKey(source: PullRequestSourceRef): string {
  return source.kind === "github" ? "github" : `mod:${source.modId}:${source.sourceId}`;
}
export function parseCodeReviewSourceKey(value: unknown): PullRequestSourceRef | null {
  if (value === "github") return { kind: "github" };
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "mod") return null;
  const source = { kind: "mod" as const, modId: parts[1], sourceId: parts[2] };
  return Schema.is(ModPullRequestSourceRef)(source) ? source : null;
}
export function codeReviewItemKey(
  source: PullRequestSourceRef,
  identity: ModPullRequestIdentity,
): string {
  return JSON.stringify([
    codeReviewSourceKey(source),
    source.kind === "github" ? identity.repository.toLowerCase() : identity.repository,
    identity.itemId,
  ]);
}
interface RowBase {
  readonly identity: ModPullRequestIdentity;
  readonly involvement: { authored: boolean; assigned: boolean; involved: boolean };
}
export type CodeReviewRow = RowBase &
  (
    | { readonly source: { readonly kind: "github" }; readonly item: GitHubInboxItem }
    | { readonly source: ModPullRequestSourceRef; readonly item: ModsPullRequestListEntry }
  );
export type ModCodeReviewRow = Extract<CodeReviewRow, { source: ModPullRequestSourceRef }>;
export function isModCodeReviewRow(row: CodeReviewRow): row is ModCodeReviewRow {
  return row.source.kind === "mod";
}
export function toCodeReviewRows(
  githubResult: GitHubInboxListResult | undefined,
  modPages: readonly ModsPullRequestListResult[],
): CodeReviewRow[] {
  const rows = new Map<string, CodeReviewRow>();
  for (const item of githubResult?.items ?? []) {
    const source = { kind: "github" as const };
    const identity = { repository: item.repository, itemId: String(item.number) };
    rows.set(codeReviewItemKey(source, identity), {
      source,
      identity,
      item,
      involvement: item.viewerInvolvement ?? { authored: false, assigned: false, involved: false },
    });
  }
  for (const page of modPages)
    for (const item of page.items) {
      const identity = { repository: item.repository, itemId: item.itemId };
      const authored = page.viewer !== null && item.author?.login === page.viewer;
      const assigned =
        page.viewer !== null &&
        item.assignees?.some((actor) => actor.login === page.viewer) === true;
      const involvement = item.viewerInvolvement ?? {
        authored,
        assigned,
        involved: authored || assigned,
      };
      rows.set(codeReviewItemKey(page.source, identity), {
        source: page.source,
        identity,
        item,
        involvement,
      });
    }
  return [...rows.values()];
}
export function sortCodeReviewRows<
  T extends { item: { createdAt: string | null; updatedAt: string | null } },
>(rows: readonly T[], sort: GitHubInboxSort): T[] {
  const date = (row: T) => {
    const value = sort === "created" ? row.item.createdAt : row.item.updatedAt;
    return value ? Date.parse(value) : null;
  };
  return [...rows].sort((a, b) => {
    const left = date(a);
    const right = date(b);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left;
  });
}
export function visibleModCodeReviewRows(
  rows: readonly CodeReviewRow[],
  filters: GitHubInboxFilters,
  query: string,
  sort: GitHubInboxSort,
): Array<Extract<CodeReviewRow, { source: ModPullRequestSourceRef }>> {
  return sortCodeReviewRows(
    rows.filter((row) => {
      if (!isModCodeReviewRow(row) || filters.kind === "issue") return false;
      const item = row.item;
      if (filters.state === "merged" && item.state !== "merged") return false;
      if (
        filters.projectIds.length &&
        !item.projectContexts.some((project) => filters.projectIds.includes(project.projectId))
      )
        return false;
      if (
        filters.labels.length &&
        !filters.labels.every((label) => item.labels?.some((value) => value.name === label))
      )
        return false;
      if (filters.involvement === "reviewRequested" && item.viewerReviewRequested !== true)
        return false;
      if (
        filters.involvement !== "everything" &&
        filters.involvement !== "reviewRequested" &&
        !row.involvement[filters.involvement]
      )
        return false;
      return (
        !query ||
        [
          item.title,
          item.repository,
          row.identity.itemId,
          item.author?.login,
          ...(item.labels?.map((label) => label.name) ?? []),
        ].some((value) => value?.toLowerCase().includes(query))
      );
    }),
    sort,
  ) as Array<Extract<CodeReviewRow, { source: ModPullRequestSourceRef }>>;
}
export function modCodeReviewSelection(
  search: GitHubInboxSearch,
): { source: ModPullRequestSourceRef; identity: ModPullRequestIdentity } | null {
  const source = parseCodeReviewSourceKey(search.selectedSource);
  return source?.kind === "mod" && search.selectedRepo && search.selectedItemId
    ? { source, identity: { repository: search.selectedRepo, itemId: search.selectedItemId } }
    : null;
}
export function modCodeReviewSelectionForItem(
  source: ModPullRequestSourceRef,
  identity: ModPullRequestIdentity,
): GitHubInboxSearchPatch {
  return {
    selectedSource: codeReviewSourceKey(source),
    selectedRepo: identity.repository,
    selectedItemId: identity.itemId,
    kind: undefined,
    number: undefined,
    selectedProjectId: undefined,
  };
}
