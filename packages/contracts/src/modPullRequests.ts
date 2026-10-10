import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { GitPullRequestMergeability } from "./git";
import {
  PullRequestAction,
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestCommitAuthor,
  PullRequestLabel,
  PullRequestMergeMethod,
  PullRequestState,
  GitHubViewerInvolvement,
} from "./pullRequests";

/** Shared with ModId without importing the mod snapshot (which contains sources). */
export const ModPullRequestSourceId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type ModPullRequestSourceId = typeof ModPullRequestSourceId.Type;
const OpaqueId = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4096));
export const ModPullRequestUrl = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }),
);
const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefault(() => null));
const falseDefault = Schema.Boolean.pipe(Schema.withDecodingDefault(() => false));
const actions = Schema.Array(PullRequestAction).pipe(Schema.withDecodingDefault(() => []));
const methods = Schema.Array(PullRequestMergeMethod).pipe(Schema.withDecodingDefault(() => []));

export const ModPullRequestSourceRef = Schema.Struct({
  kind: Schema.Literal("mod"),
  modId: ModPullRequestSourceId,
  sourceId: ModPullRequestSourceId,
});
export type ModPullRequestSourceRef = typeof ModPullRequestSourceRef.Type;
export const PullRequestSourceRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("github") }),
  ModPullRequestSourceRef,
]);
export type PullRequestSourceRef = typeof PullRequestSourceRef.Type;
export const ModPullRequestCapabilities = Schema.Struct({
  diff: falseDefault,
  timeline: falseDefault,
  comment: falseDefault,
  actions,
  mergeMethods: methods,
});
export type ModPullRequestCapabilities = typeof ModPullRequestCapabilities.Type;
export const ModPullRequestSourceDefinition = Schema.Struct({
  id: ModPullRequestSourceId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  capabilities: ModPullRequestCapabilities.pipe(
    Schema.withDecodingDefault(() => ({
      diff: false,
      timeline: false,
      comment: false,
      actions: [],
      mergeMethods: [],
    })),
  ),
});
export type ModPullRequestSourceDefinition = typeof ModPullRequestSourceDefinition.Type;
export const ModPullRequestSourceSummary = Schema.Struct({
  source: ModPullRequestSourceRef,
  title: TrimmedNonEmptyString,
  capabilities: ModPullRequestCapabilities,
  revision: TrimmedNonEmptyString,
});
export type ModPullRequestSourceSummary = typeof ModPullRequestSourceSummary.Type;
export const ModPullRequestIdentity = Schema.Struct({ repository: OpaqueId, itemId: OpaqueId });
export type ModPullRequestIdentity = typeof ModPullRequestIdentity.Type;

// Reuse the native shapes, tightening only their display-link fields at this boundary.
export const ModPullRequestActor = Schema.Struct({
  ...PullRequestActor.fields,
  avatarUrl: nullable(ModPullRequestUrl),
  url: nullable(ModPullRequestUrl),
});
export type ModPullRequestActor = typeof ModPullRequestActor.Type;
const CommitAuthor = Schema.Struct({
  ...PullRequestCommitAuthor.fields,
  avatarUrl: nullable(ModPullRequestUrl),
  url: nullable(ModPullRequestUrl),
});
const Check = Schema.Struct({ ...PullRequestCheck.fields, url: nullable(ModPullRequestUrl) });
const Comment = Schema.Struct({
  ...PullRequestComment.fields,
  author: nullable(ModPullRequestActor),
  url: nullable(ModPullRequestUrl),
});
const Commit = Schema.Struct({ ...PullRequestCommit.fields, authors: Schema.Array(CommitAuthor) });

export const ModPullRequestListEntry = Schema.Struct({
  ...ModPullRequestIdentity.fields,
  title: TrimmedNonEmptyString,
  url: ModPullRequestUrl,
  state: PullRequestState,
  displayNumber: nullable(PositiveInt),
  isDraft: nullable(Schema.Boolean),
  author: nullable(ModPullRequestActor),
  headBranch: nullable(TrimmedNonEmptyString),
  baseBranch: nullable(TrimmedNonEmptyString),
  additions: nullable(NonNegativeInt),
  deletions: nullable(NonNegativeInt),
  commentCount: nullable(NonNegativeInt),
  createdAt: nullable(IsoDateTime),
  updatedAt: nullable(IsoDateTime),
  reviewDecision: nullable(Schema.String),
  viewerReviewRequested: nullable(Schema.Boolean),
  viewerInvolvement: nullable(GitHubViewerInvolvement),
  labels: nullable(Schema.Array(PullRequestLabel)),
  assignees: nullable(Schema.Array(ModPullRequestActor)),
  projectIds: Schema.Array(ProjectId).pipe(Schema.withDecodingDefault(() => [])),
});
export type ModPullRequestListEntry = typeof ModPullRequestListEntry.Type;
export const ModPullRequestDetail = Schema.Struct({
  ...ModPullRequestListEntry.fields,
  body: nullable(Schema.String),
  changedFiles: nullable(NonNegativeInt),
  mergedAt: nullable(IsoDateTime),
  closedAt: nullable(IsoDateTime),
  mergeability: GitPullRequestMergeability.pipe(Schema.withDecodingDefault(() => "unknown")),
  mergeStateStatus: nullable(Schema.String),
  reviewers: nullable(Schema.Array(ModPullRequestActor)),
  checks: nullable(Schema.Array(Check)),
  comments: nullable(Schema.Array(Comment)),
  commits: nullable(Schema.Array(Commit)),
  commentsTruncated: falseDefault,
  commentsIncomplete: falseDefault,
  mergeMethods: methods,
});
export type ModPullRequestDetail = typeof ModPullRequestDetail.Type;
export const ModPullRequestListResult = Schema.Struct({
  items: Schema.Array(ModPullRequestListEntry).check(Schema.isMaxLength(500)),
  nextCursor: nullable(OpaqueId),
  totalCount: nullable(NonNegativeInt),
  viewer: nullable(TrimmedNonEmptyString),
});
export type ModPullRequestListResult = typeof ModPullRequestListResult.Type;
export const ModPullRequestMutationResult = Schema.Struct({
  ok: Schema.Literal(true),
  mergeOutcome: nullable(Schema.Literals(["merged", "enqueued"])),
});
export type ModPullRequestMutationResult = typeof ModPullRequestMutationResult.Type;

const SourceInput = { modId: ModPullRequestSourceId, sourceId: ModPullRequestSourceId };
export const ModsPullRequestListInput = Schema.Struct({
  ...SourceInput,
  state: Schema.Literals(["open", "closed"]),
  sort: Schema.Literals(["created", "updated"]),
  cursor: nullable(OpaqueId),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(500)).pipe(
    Schema.withDecodingDefault(() => 100),
  ),
});
export type ModsPullRequestListInput = typeof ModsPullRequestListInput.Type;
export const ModsPullRequestDetailInput = Schema.Struct({
  ...SourceInput,
  ...ModPullRequestIdentity.fields,
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ModsPullRequestDetailInput = typeof ModsPullRequestDetailInput.Type;
export const ModsPullRequestDiffInput = Schema.Struct({
  ...SourceInput,
  ...ModPullRequestIdentity.fields,
});
export type ModsPullRequestDiffInput = typeof ModsPullRequestDiffInput.Type;
export const ModsPullRequestCommentInput = Schema.Struct({
  ...ModsPullRequestDiffInput.fields,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
});
export type ModsPullRequestCommentInput = typeof ModsPullRequestCommentInput.Type;
export const ModsPullRequestActionInput = Schema.Struct({
  ...ModsPullRequestDiffInput.fields,
  action: PullRequestAction,
  mergeMethod: Schema.optional(PullRequestMergeMethod),
});
export type ModsPullRequestActionInput = typeof ModsPullRequestActionInput.Type;
export const ModsPullRequestSetPinnedInput = Schema.Struct({
  ...ModsPullRequestDiffInput.fields,
  isPinned: Schema.Boolean,
});
export type ModsPullRequestSetPinnedInput = typeof ModsPullRequestSetPinnedInput.Type;

export const ModPullRequestProjectContext = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type ModPullRequestProjectContext = typeof ModPullRequestProjectContext.Type;
export const ModsPullRequestListEntry = Schema.Struct({
  ...ModPullRequestListEntry.fields,
  projectContexts: Schema.Array(ModPullRequestProjectContext),
  isPinned: Schema.Boolean,
});
export type ModsPullRequestListEntry = typeof ModsPullRequestListEntry.Type;
export const ModsPullRequestListResult = Schema.Struct({
  ...ModPullRequestListResult.fields,
  source: ModPullRequestSourceRef,
  revision: TrimmedNonEmptyString,
  items: Schema.Array(ModsPullRequestListEntry),
});
export type ModsPullRequestListResult = typeof ModsPullRequestListResult.Type;
export const ModsPullRequestDetailResult = Schema.Struct({
  ...ModPullRequestDetail.fields,
  source: ModPullRequestSourceRef,
  revision: TrimmedNonEmptyString,
  projectContexts: Schema.Array(ModPullRequestProjectContext),
  isPinned: Schema.Boolean,
});
export type ModsPullRequestDetailResult = typeof ModsPullRequestDetailResult.Type;
export const ModsPullRequestSetPinnedResult = Schema.Struct({
  source: ModPullRequestSourceRef,
  ...ModPullRequestIdentity.fields,
  isPinned: Schema.Boolean,
});
export type ModsPullRequestSetPinnedResult = typeof ModsPullRequestSetPinnedResult.Type;
