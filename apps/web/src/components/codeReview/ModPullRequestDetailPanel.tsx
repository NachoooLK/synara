import { useStore } from "~/store";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { addChatPullRequestContext } from "~/lib/chatReferences";
import {
  modPullRequestActionMutationOptions,
  modPullRequestCommentMutationOptions,
  modPullRequestSetPinnedMutationOptions,
} from "~/lib/modPullRequestMutationOptions";
import { toastManager } from "~/components/ui/toast";
import { IconButton } from "~/components/ui/icon-button";
import { Menu, MenuTrigger } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { EllipsisIcon } from "~/lib/icons";
import { GitHubItemAgentActions } from "../pullRequest/GitHubItemAgentActions";
import {
  modItemCardSourceFromDetail,
  codeReviewItemContextDraft,
} from "../pullRequest/githubItemAgentContext";
import {
  PullRequestPrimaryButton,
  PullRequestActionMenuItems,
} from "../pullRequest/PullRequestActions";
import {
  PullRequestConfirmActionDialog,
  type PullRequestConfirmAction,
} from "../pullRequest/PullRequestConfirmActionDialog";
import { PullRequestCommentComposer } from "../pullRequest/PullRequestCommentComposer";
import type {
  ModPullRequestSourceSummary,
  ModPullRequestIdentity,
  PullRequestAction,
  PullRequestMergeMethod,
  ProjectId,
} from "@synara/contracts";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, useRef } from "react";
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
  GitHubItemAskComposer,
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
  const client = useQueryClient();
  const actionMutation = useMutation(modPullRequestActionMutationOptions(client));
  const commentMutation = useMutation(modPullRequestCommentMutationOptions(client));
  const pinMutation = useMutation(modPullRequestSetPinnedMutationOptions(client));
  const [confirm, setConfirm] = useState<PullRequestConfirmAction | null>(null);
  const [chosenMethod, setMethod] = useState<PullRequestMergeMethod | null>(null);
  const lock = useRef(false);
  const sendLock = useRef(false);
  const [sending, setSending] = useState(false);
  const { handleNewThread } = useHandleNewThread();
  const projects = useStore((store) => store.projects);
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
  const input = source
    ? { ...identity, modId: source.source.modId, sourceId: source.source.sourceId }
    : null;
  const methods =
    source && detail
      ? source.capabilities.mergeMethods.filter((method) => detail.mergeMethods.includes(method))
      : [];
  const method = chosenMethod && methods.includes(chosenMethod) ? chosenMethod : methods[0];
  const allowed = (source?.capabilities.actions ?? []).filter((action) =>
    detail?.state === "open"
      ? action === "close" ||
        (action === "merge" && detail.isDraft !== true && methods.length > 0) ||
        (action === "draft" && detail.isDraft === false) ||
        (action === "ready" && detail.isDraft === true)
      : detail?.state === "closed" && action === "reopen",
  );
  const runAction = (action: PullRequestAction, mergeMethod?: PullRequestMergeMethod) => {
    if (!input || !allowed.includes(action) || lock.current) return;
    lock.current = true;
    void actionMutation
      .mutateAsync({ ...input, action, ...(mergeMethod ? { mergeMethod } : {}) })
      .then((result) => {
        setConfirm(null);
        toastManager.add({
          type: "success",
          title:
            action === "merge"
              ? result.mergeOutcome === "enqueued"
                ? "Pull request added to merge queue"
                : "Pull request merged"
              : action === "ready"
                ? "Marked ready for review"
                : action === "draft"
                  ? "Converted to draft"
                  : action === "close"
                    ? "Pull request closed"
                    : "Pull request reopened",
        });
      })
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: "Pull request action failed",
          description:
            error instanceof Error ? error.message : "The source did not confirm this action.",
        }),
      )
      .finally(() => {
        lock.current = false;
      });
  };
  const primary = allowed.includes("ready")
    ? { kind: "ready" as const }
    : allowed.includes("merge")
      ? {
          kind: "merge" as const,
          blockedReason:
            detail?.mergeability === "conflicting"
              ? "This pull request has conflicts."
              : detail?.isDraft === null
                ? "Draft state unknown."
                : null,
          stackCount: null,
        }
      : null;
  const sendTargets = projects
    .filter((project) => project.kind === "project")
    .map((project) => ({ projectId: project.id, projectTitle: project.name }));
  const defaultProject =
    detail?.projectContexts.find((context) =>
      sendTargets.some((target) => target.projectId === context.projectId),
    )?.projectId ?? sendTargets[0]?.projectId;
  const send = (projectId: ProjectId) => {
    if (
      !detail ||
      !source ||
      sendLock.current ||
      !useStore
        .getState()
        .projects.some((project) => project.kind === "project" && project.id === projectId)
    )
      return;
    sendLock.current = true;
    setSending(true);
    void handleNewThread(projectId, { fresh: true })
      .then((threadId) => {
        if (!threadId) throw new Error("Could not create a draft thread.");
        addChatPullRequestContext(
          threadId,
          codeReviewItemContextDraft(modItemCardSourceFromDetail(detail)),
        );
      })
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: "Could not open a chat",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      )
      .finally(() => {
        sendLock.current = false;
        setSending(false);
      });
  };
  const composer =
    detail && defaultProject ? (
      <GitHubItemAskComposer
        noun="pull request"
        defaultProjectId={defaultProject}
        sendTargets={sendTargets}
        buildTarget={(projectId) => ({ projectId, source: modItemCardSourceFromDetail(detail) })}
        host={pageHost}
        onSendToAgent={send}
      />
    ) : null;
  const togglePin = () => {
    if (!input || !detail || pinMutation.isPending) return;
    pinMutation.mutate(
      { ...input, isPinned: !detail.isPinned },
      {
        onError: (error) =>
          toastManager.add({
            type: "error",
            title: "Could not update pin",
            description: error instanceof Error ? error.message : "Try again.",
          }),
      },
    );
  };

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
          <>
            {primary ? (
              <PullRequestPrimaryButton
                action={primary}
                merging={actionMutation.isPending && actionMutation.variables?.action === "merge"}
                disabled={actionMutation.isPending}
                onReady={() => runAction("ready")}
                onMerge={() => {
                  if (method) setConfirm({ kind: "merge", method });
                }}
                size="sm"
              />
            ) : null}
            {allowed.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <IconButton
                      variant="ghost"
                      size="icon-sm"
                      label="More pull request actions"
                      children={null}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end">
                  <PullRequestActionMenuItems
                    detail={{ ...detail, isDraft: detail.isDraft === true }}
                    host="page"
                    actionPending={actionMutation.isPending}
                    mergeMethods={methods}
                    selectedMergeMethod={method ?? "merge"}
                    mergeBlocker={primary?.kind === "merge" ? primary.blockedReason : null}
                    preparingThread={null}
                    sendTargets={[]}
                    askPending={false}
                    onStateChange={(action) => runAction(action)}
                    onMergeMethodChange={setMethod}
                    onSendToAgent={send}
                    onAsk={undefined}
                    onFixFindings={() => undefined}
                    onResolveConflicts={() => undefined}
                    onClose={() => setConfirm({ kind: "close" })}
                    onReopen={() => runAction("reopen")}
                    allowedActions={allowed}
                    allowGitHubHandoffs={false}
                  />
                </ComposerPickerMenuPopup>
              </Menu>
            ) : null}
            <GitHubItemAgentActions
              sendTargets={sendTargets}
              sending={sending}
              onSendToAgent={send}
            />
            <GitHubItemPageIconActions
              url={detail.url}
              itemLabel={`pull request ${detail.displayNumber === null ? detail.itemId : `#${detail.displayNumber}`}`}
              pin={{ pinned: detail.isPinned, onToggle: togglePin }}
              externalLabel="Open on source"
            />
          </>
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
      overlay={
        detail ? (
          <PullRequestConfirmActionDialog
            action={confirm}
            number={detail.displayNumber ?? detail.itemId}
            baseBranch={detail.baseBranch}
            stack={null}
            stackMergeTargetCount={1}
            pending={actionMutation.isPending}
            onDismiss={() => setConfirm(null)}
            onConfirm={(action) =>
              runAction(action.kind, action.kind === "merge" ? action.method : undefined)
            }
          />
        ) : null
      }
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
            composer={composer}
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
              {input && source?.capabilities.comment ? (
                <PullRequestCommentComposer
                  target={input}
                  mutation={commentMutation}
                  genericSource
                  accountLabel={`Commenting through ${source.title}`}
                />
              ) : null}
            </GitHubItemPageSummary>
          </GitHubItemPageBody>
        ) : (
          <GitHubItemTabBody
            glyph={<PullRequestStateGlyph state={detail.state} isDraft={detail.isDraft === true} />}
            composer={composer}
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
