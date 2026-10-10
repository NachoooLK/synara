import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  GitHubInboxState,
  GitHubInboxSort,
  ModsPullRequestListResult,
} from "@synara/contracts";
import { MODS_ON } from "~/betaFeatures";
import { useModsStore } from "~/mods/modsStore";
import { ensureNativeApi } from "~/nativeApi";
import { githubInboxListQueryOptions } from "~/lib/githubInboxQueryOptions";
import { modPullRequestListQueryOptions } from "~/lib/modPullRequestQueryOptions";
import { codeReviewSourceKey, toCodeReviewRows } from "./codeReview.logic";
export function useCodeReviewSources({
  state,
  sort,
  origin = "all",
}: {
  state: GitHubInboxState;
  sort: GitHubInboxSort;
  origin?: string;
}) {
  const snapshot = useModsStore((store) => store.snapshot);
  const client = useQueryClient();
  const sources = MODS_ON
    ? (snapshot?.mods ?? [])
        .filter((mod) => mod.status === "running")
        .flatMap((mod) => mod.pullRequestSources)
    : [];
  const visible = sources.filter(
    (source) => origin === "all" || origin === codeReviewSourceKey(source.source),
  );
  const githubQuery = useQuery({
    ...githubInboxListQueryOptions(state, sort),
    enabled: origin === "all" || origin === "github",
  });
  const queries = useQueries({
    queries: visible.map((source) => modPullRequestListQueryOptions(source, state, sort)),
  });
  const [extra, setExtra] = useState<
    Record<string, { first: ModsPullRequestListResult; pages: ModsPullRequestListResult[] }>
  >({});
  const refreshEpoch = useRef(0);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const loads = useRef(new Set<string>());
  const pageKey = (index: number) =>
    JSON.stringify([visible[index]!.source, visible[index]!.revision, state, sort]);
  const extraPages = (index: number) => {
    const saved = extra[pageKey(index)];
    return saved && saved.first === queries[index]?.data ? saved.pages : [];
  };
  useEffect(() => {
    setExtra((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([key, value]) =>
          queries.some((query, index) => pageKey(index) === key && query.data === value.first),
        ),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  });
  const pages = queries.flatMap((query, index) =>
    query.data ? [query.data, ...extraPages(index)] : [],
  );
  const pagination = visible.flatMap((source, index) => {
    const key = pageKey(index);
    const first = queries[index]?.data;
    const loaded = extraPages(index);
    const last = loaded.at(-1) ?? first;
    if (!last?.nextCursor) return [];
    const cursor = last.nextCursor;
    return [
      {
        key: codeReviewSourceKey(source.source),
        title: source.title,
        totalCount: last.totalCount,
        pending: pending[key] === true,
        loadMore: async () => {
          if (loads.current.has(key)) return;
          loads.current.add(key);
          setPending((value) => ({ ...value, [key]: true }));
          const epoch = refreshEpoch.current;
          try {
            const next = await client.fetchQuery(
              modPullRequestListQueryOptions(source, state, sort, cursor),
            );
            if (first && epoch === refreshEpoch.current)
              setExtra((value) => ({
                ...value,
                [key]: {
                  first,
                  pages: [...(value[key]?.first === first ? value[key]!.pages : []), next],
                },
              }));
          } finally {
            loads.current.delete(key);
            setPending((value) => ({ ...value, [key]: false }));
          }
        },
      },
    ];
  });
  const notices = queries.flatMap((query, index) =>
    query.error
      ? [
          {
            source: visible[index]!.source,
            title: visible[index]!.title,
            error: query.error,
            cached: query.data !== undefined,
          },
        ]
      : [],
  );
  const refresh = async () => {
    refreshEpoch.current++;
    setExtra({});
    await Promise.allSettled([
      ...(origin === "all" || origin === "github"
        ? [
            client.fetchQuery({
              ...githubInboxListQueryOptions(state, sort),
              staleTime: 0,
              queryFn: () =>
                ensureNativeApi().githubInbox.list({ state, sort, forceRefresh: true }),
            }),
          ]
        : []),
      ...queries.map((query) => query.refetch()),
    ]);
  };
  return {
    rows: toCodeReviewRows(
      origin === "all" || origin === "github" ? githubQuery.data : undefined,
      pages,
    ),
    sources,
    notices,
    pagination,
    githubQuery,
    refresh,
    loading:
      ((origin === "all" || origin === "github") && githubQuery.isPending) ||
      queries.some((query) => query.isPending),
    refreshing:
      ((origin === "all" || origin === "github") && githubQuery.isFetching) ||
      queries.some((query) => query.isFetching),
  };
}
