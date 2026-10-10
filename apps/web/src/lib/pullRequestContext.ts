import type { ModPullRequestSourceRef } from "@synara/contracts";

// FILE: pullRequestContext.ts
// Purpose: Shared helpers for GitHub item context cards — the composer attachment that
//   "Repair" / "Add to chat" in the PR menu and the inbox's Send to agent / Ask create instead
//   of pasting a long prompt into the editor. A card is about a pull request or, with
//   `itemKind: "issue"`, an issue. A card shows a short title + subtitle; its full prompt rides to the
//   provider in a trailing <pull_request_context> block and is parsed back out to render
//   the same card in the transcript.
// Layer: Web composer utility
// Depends on: nothing (kept import-free so both composer state and message display can
//   consume it without cycles).

/** What the card asks the agent to do. Drives the icon and the accessible labels. */
export const PULL_REQUEST_CONTEXT_SCOPES = [
  "reference",
  "comments",
  "checks",
  "conflicts",
  "everything",
] as const;
export type PullRequestContextScope = (typeof PULL_REQUEST_CONTEXT_SCOPES)[number];

/** What the card is about. Cards stored before issues existed have no kind: a pull request. */
export type PullRequestContextItemKind = "pullRequest" | "issue";

export interface PullRequestContextDraft {
  id: string;
  createdAt: string;
  scope: PullRequestContextScope;
  /** Absent means a pull request, so drafts and transcripts written earlier still parse. */
  itemKind?: PullRequestContextItemKind;
  /** The item's number and URL (named for pull requests, which came first). */
  prNumber: number | null;
  source?: ModPullRequestSourceRef;
  repository?: string;
  itemId?: string;
  prUrl: string;
  /** Card headline, e.g. "1 failing check". */
  title: string;
  /** Card detail line, e.g. "Test, lint, build, and smoke". */
  subtitle: string;
  /** Full prompt handed to the provider; never shown inline. */
  text: string;
}

export interface ParsedPullRequestContextEntry {
  index: number;
  scope: PullRequestContextScope;
  itemKind: PullRequestContextItemKind;
  prNumber: number | null;
  source?: ModPullRequestSourceRef;
  repository?: string;
  itemId?: string;
  prUrl: string;
  title: string;
  subtitle: string;
  text: string;
}

export interface ExtractedPullRequestContexts {
  promptText: string;
  pullRequestContexts: ParsedPullRequestContextEntry[];
}

const TRAILING_PULL_REQUEST_CONTEXT_BLOCK_PATTERN =
  /\n*<pull_request_context>\n([\s\S]*?)\n<\/pull_request_context>\s*$/;

interface SerializedPullRequestContextEntry {
  readonly scope: PullRequestContextScope;
  readonly itemKind?: "issue";
  readonly prNumber: number | null;
  readonly source?: ModPullRequestSourceRef;
  readonly repository?: string;
  readonly itemId?: string;
  readonly prUrl: string;
  readonly title: string;
  readonly subtitle: string;
  readonly text: string;
}

export function isModContextIdentity(value: {
  source?: unknown;
  repository?: unknown;
  itemId?: unknown;
}): value is { source: ModPullRequestSourceRef; repository: string; itemId: string } {
  const source = value.source;
  return (
    !!source &&
    typeof source === "object" &&
    "kind" in source &&
    source.kind === "mod" &&
    "modId" in source &&
    typeof source.modId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(source.modId) &&
    "sourceId" in source &&
    typeof source.sourceId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(source.sourceId) &&
    typeof value.repository === "string" &&
    /\S/.test(value.repository) &&
    value.repository.length <= 4096 &&
    typeof value.itemId === "string" &&
    /\S/.test(value.itemId) &&
    value.itemId.length <= 4096
  );
}
function modIdentity(value: { source?: unknown; repository?: unknown; itemId?: unknown }) {
  return isModContextIdentity(value)
    ? { source: value.source, repository: value.repository, itemId: value.itemId }
    : {};
}
function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function isPullRequestContextScope(value: unknown): value is PullRequestContextScope {
  return (
    typeof value === "string" &&
    (PULL_REQUEST_CONTEXT_SCOPES as ReadonlyArray<string>).includes(value)
  );
}

// Null when the card has nothing to send: an empty prompt would attach a bubble that
// contributes nothing to the message.
export function normalizePullRequestContext(
  draft: PullRequestContextDraft,
): PullRequestContextDraft | null {
  const id = draft.id.trim();
  const text = normalizeText(draft.text);
  const title = normalizeLine(draft.title);
  if (id.length === 0 || text.length === 0 || title.length === 0) {
    return null;
  }
  if (!isPullRequestContextScope(draft.scope)) {
    return null;
  }
  if (
    draft.source
      ? !isModContextIdentity(draft) ||
        (draft.prNumber !== null && (!Number.isInteger(draft.prNumber) || draft.prNumber <= 0))
      : draft.prNumber === null || !Number.isInteger(draft.prNumber) || draft.prNumber <= 0
  ) {
    return null;
  }
  return {
    id,
    createdAt: draft.createdAt,
    scope: draft.scope,
    ...(draft.itemKind === "issue" ? { itemKind: "issue" as const } : {}),
    ...modIdentity(draft),
    prNumber: draft.prNumber,
    prUrl: draft.prUrl.trim(),
    title,
    subtitle: normalizeLine(draft.subtitle),
    text,
  };
}

export function normalizePullRequestContexts(
  contexts: ReadonlyArray<PullRequestContextDraft>,
): PullRequestContextDraft[] {
  const normalized: PullRequestContextDraft[] = [];
  const seenIds = new Set<string>();
  for (const context of contexts) {
    const entry = normalizePullRequestContext(context);
    if (!entry || seenIds.has(entry.id)) {
      continue;
    }
    seenIds.add(entry.id);
    normalized.push(entry);
  }
  return normalized;
}

/**
 * Cards for the same PR + scope replace each other: clicking "Failing checks" twice must
 * not stack two identical bubbles, but a fresher snapshot should win over a stale one.
 */
export function pullRequestContextDedupKey(
  context: Pick<
    PullRequestContextDraft,
    "scope" | "prNumber" | "prUrl" | "source" | "repository" | "itemId"
  >,
): string {
  if (isModContextIdentity(context))
    return JSON.stringify([
      context.scope,
      context.source.kind,
      context.source.modId,
      context.source.sourceId,
      context.repository,
      context.itemId,
    ]);
  return `${context.scope}\u0000${context.prNumber}\u0000${context.prUrl}`;
}

export function pullRequestContextItemLabel(
  context: Pick<PullRequestContextDraft, "itemKind" | "prNumber" | "source" | "itemId">,
): string {
  if (context.source)
    return `PR ${context.prNumber === null ? (context.itemId ?? "") : `#${context.prNumber}`}`;
  return `${context.itemKind === "issue" ? "Issue" : "PR"} #${context.prNumber}`;
}

export function formatPullRequestContextTitleSeed(
  contexts: ReadonlyArray<
    Pick<PullRequestContextDraft, "title" | "prNumber" | "itemKind" | "source" | "itemId">
  >,
): string | null {
  const first = contexts[0];
  if (!first) {
    return null;
  }
  const itemLabel = pullRequestContextItemLabel(first);
  return contexts.length === 1 ? `${first.title} on ${itemLabel}` : itemLabel;
}

// --- Send-time serialization (cards -> trailing block)

export function buildPullRequestContextBlock(
  contexts: ReadonlyArray<PullRequestContextDraft>,
): string {
  const usable = normalizePullRequestContexts(contexts);
  if (usable.length === 0) {
    return "";
  }
  const payload: SerializedPullRequestContextEntry[] = usable.map((context) =>
    // Only issue cards carry a kind, so pull request blocks stay byte-identical to older ones.
    context.itemKind === "issue"
      ? {
          scope: context.scope,
          itemKind: "issue",
          ...modIdentity(context),
          prNumber: context.prNumber,
          prUrl: context.prUrl,
          title: context.title,
          subtitle: context.subtitle,
          text: context.text,
        }
      : {
          scope: context.scope,
          ...modIdentity(context),
          prNumber: context.prNumber,
          prUrl: context.prUrl,
          title: context.title,
          subtitle: context.subtitle,
          text: context.text,
        },
  );
  return ["<pull_request_context>", JSON.stringify(payload), "</pull_request_context>"].join("\n");
}

export function appendPullRequestContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<PullRequestContextDraft>,
): string {
  const block = buildPullRequestContextBlock(contexts);
  const trimmed = prompt.trim();
  if (block.length === 0) {
    return trimmed;
  }
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

// --- Display-time extraction (trailing block -> cards)

function parseEntries(block: string): ParsedPullRequestContextEntry[] {
  try {
    const parsed: unknown = JSON.parse(block.trim());
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const candidate = entry as Partial<Record<keyof SerializedPullRequestContextEntry, unknown>>;
      if (
        !isPullRequestContextScope(candidate.scope) ||
        typeof candidate.text !== "string" ||
        typeof candidate.title !== "string"
      ) {
        return [];
      }
      const prNumber =
        typeof candidate.prNumber === "number"
          ? candidate.prNumber
          : isModContextIdentity(candidate)
            ? null
            : 0;
      return [
        {
          index: index + 1,
          scope: candidate.scope,
          itemKind: candidate.itemKind === "issue" ? "issue" : "pullRequest",
          ...modIdentity(candidate),
          prNumber,
          prUrl: typeof candidate.prUrl === "string" ? candidate.prUrl : "",
          title: candidate.title,
          subtitle: typeof candidate.subtitle === "string" ? candidate.subtitle : "",
          text: candidate.text,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function extractTrailingPullRequestContexts(prompt: string): ExtractedPullRequestContexts {
  const match = TRAILING_PULL_REQUEST_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, pullRequestContexts: [] };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  return { promptText, pullRequestContexts: parseEntries(match[1] ?? "") };
}
