import type { ModPullRequestSourceSummary, ModPullRequestIdentity } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import {
  modPullRequestDetailQueryOptions,
  modPullRequestDiffQueryOptions,
} from "~/lib/modPullRequestQueryOptions";
import { pullRequestQueryErrorState } from "~/lib/pullRequestReactQuery";
import { GitHubItemHeader } from "../pullRequest/GitHubItemHeader";
import { PullRequestInfo } from "../pullRequest/GitHubItemInfo";
import {
  DETACHED_GITHUB_ITEM_PAGE_HOST,
  GitHubItemDetailPage,
  GitHubItemPageBody,
  GitHubItemPageIconActions,
  GitHubItemTabs,
  GitHubItemTabBody,
  PullRequestDetailSkeleton,
  type GitHubItemPageHost,
  type GitHubItemTabOption,
} from "../pullRequest/GitHubItemPageLayout";
import { GitHubItemPageSummary } from "../pullRequest/PullRequestSummaryTab";
import { PullRequestCommentCard } from "../pullRequest/PullRequestCommentCard";
import { PullRequestTimelineTab } from "../pullRequest/PullRequestTimelineTab";
import { PullRequestStateGlyph } from "../pullRequest/PullRequestStateGlyph";
import { PullRequestWarningNote } from "../pullRequest/PullRequestWarningNote";
import { codeReviewItemKey } from "./codeReview.logic";

const DiffBody = lazy(() =>
  import("../pullRequest/PullRequestCodeTab").then((module) => ({
    default: module.PullRequestDiffBody,
  })),
);
type Tab = "summary" | "changes" | "timeline";
export function ModPullRequestDetailPanel({
  source,
  identity,
  pageHost = DETACHED_GITHUB_ITEM_PAGE_HOST,
  onBack,
}: {
  source: ModPullRequestSourceSummary | null;
  identity: ModPullRequestIdentity;
  pageHost?: GitHubItemPageHost;
  onBack?: (() => void) | undefined;
}) {
  const [chosenTab, setTab] = useState<Tab>("summary");
  const tabs: GitHubItemTabOption<Tab>[] = [
    { value: "summary", label: "Summary" },
    ...(source?.capabilities.diff ? [{ value: "changes" as const, label: "Changes" }] : []),
    ...(source?.capabilities.timeline ? [{ value: "timeline" as const, label: "Timeline" }] : []),
  ];
  const tab = tabs.some((option) => option.value === chosenTab) ? chosenTab : "summary";
  const detailQuery = useQuery(modPullRequestDetailQueryOptions(source, identity));
  const diffQuery = useQuery(modPullRequestDiffQueryOptions(source, identity, tab === "changes"));
  const detail = source ? detailQuery.data : undefined;
  const errors = pullRequestQueryErrorState(detailQuery);
  const workspaceRoot = detail?.projectContexts[0]?.workspaceRoot;
  return (
    <GitHubItemDetailPage
      onBack={onBack}
      tabs={
        <GitHubItemTabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          label="Pull request detail tabs"
        />
      }
      actions={
        detail ? (
          <GitHubItemPageIconActions
            url={detail.url}
            itemLabel={`pull request ${detail.displayNumber === null ? detail.itemId : `#${detail.displayNumber}`}`}
            pin={pageHost.pin}
            externalLabel="Open on source"
          />
        ) : null
      }
      query={{
        isPending: source !== null && detailQuery.isPending,
        initialError:
          source === null
            ? new Error(
                "This mod source is unavailable. Enable it or trust its changes in Settings → Mods.",
              )
            : errors.initialError,
        subject: source?.title ?? "Mod source",
        loaded: detail !== undefined,
        onRetry: () => void detailQuery.refetch(),
      }}
      notFound={{
        title: "Pull request unavailable",
        description: "The source did not return this item.",
      }}
      banners={
        errors.backgroundError ? (
          <PullRequestWarningNote shape="banner">
            The latest refresh failed. Showing the last loaded detail.
          </PullRequestWarningNote>
        ) : null
      }
    >
      {detail ? (
        tab === "summary" ? (
          <GitHubItemPageBody
            header={
              <GitHubItemHeader
                item={{ ...detail, kind: "pullRequest", number: detail.displayNumber }}
              />
            }
            info={(variant) => (
              <PullRequestInfo
                detail={detail}
                variant={variant}
                requestReview={false}
                threads={pageHost.threads}
                onOpenThread={pageHost.onOpenThread}
              />
            )}
          >
            <GitHubItemPageSummary
              body={detail.body}
              workspaceRoot={workspaceRoot}
              commentCount={detail.commentCount}
            >
              {detail.comments === null ? (
                <p className="text-ui text-muted-foreground">Comments unavailable.</p>
              ) : detail.comments.length === 0 ? (
                <p className="text-ui text-muted-foreground">No comments</p>
              ) : (
                detail.comments.map((comment, index) => (
                  <PullRequestCommentCard
                    key={comment.id}
                    comment={comment}
                    prUrl={detail.url}
                    workspaceRoot={workspaceRoot}
                    defaultOpen={index >= detail.comments!.length - 2}
                  />
                ))
              )}
              {detail.commentsIncomplete || detail.commentsTruncated ? (
                <PullRequestWarningNote>
                  Some comments are missing. Open the source for the complete conversation.
                </PullRequestWarningNote>
              ) : null}
            </GitHubItemPageSummary>
          </GitHubItemPageBody>
        ) : (
          <GitHubItemTabBody
            glyph={<PullRequestStateGlyph state={detail.state} isDraft={detail.isDraft === true} />}
            title={detail.title}
          >
            {tab === "timeline" ? (
              <PullRequestTimelineTab detail={detail} />
            ) : (
              <Suspense fallback={<PullRequestDetailSkeleton />}>
                <DiffBody
                  identityKey={codeReviewItemKey(detail.source, identity)}
                  workspaceRoot={workspaceRoot ?? null}
                  diffQuery={diffQuery}
                />
              </Suspense>
            )}
          </GitHubItemTabBody>
        )
      ) : null}
    </GitHubItemDetailPage>
  );
}
