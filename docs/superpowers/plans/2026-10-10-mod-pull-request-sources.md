# Generic Mod Pull Request Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any enabled mod supply pull requests and supported operations to Synara's native Code review page, and teach agents to author these sources.

**Architecture:** Mods register named sources and answer typed request hooks. The host validates and dispatches to the owning mod, while native Code review combines source-aware presentation data with existing GitHub items. Keep the existing GitHub RPC and cache paths and reuse native presentation components.

**Tech Stack:** TypeScript, Effect schemas and services, worker hooks, existing WebSocket RPC, React, TanStack Query/Router, Vitest and Vitest Browser.

**Spec:** [Mod pull request sources in Code review](../specs/2026-10-10-mod-pull-request-sources-design.md), approved by Nacho on 2026-10-10.

## Global Constraints

- Work in `/Users/nacho/.synara/worktrees/a18e/synara`, branch `synara/plan-synara-plugin-system`. Preserve the existing mods commits and approved design commit `3e3580d59`.
- Apply `synara-fresh-base` at execution start; the current upstream base is `6f54f53c6`.
- The Synara runtime and native UI must contain no Paraty or Bitbucket dispatch rules.
- The existing mods Beta gate applies to registration, request dispatch, snapshot metadata, navigation controls, and persisted origin-aware references.
- Local source IDs: lowercase words joined by dashes, up to 64 characters. A running mod may register up to ten sources.
- A list request defaults to 100 items and permits at most 500. A source has at most four concurrent reads.
- Mod sources have no periodic polling. Reuse the existing worker hook limits, including its 60-second wall-clock limit.
- Preserve opaque, case-sensitive mod repository and item IDs. Do not infer ownership from URLs or fabricate project IDs, counts, or dates.
- Capabilities govern the UI and authoritative host dispatch. An omitted capability is unsupported.
- Reuse existing MCP transport and per-mod, per-server sign-in. Credential reuse from provider CLIs is outside this plan.
- UI text uses `text-ui*`; reuse native controls, diff, markdown, disclosure, and responsive layout components.
- Use `bun run test`, never `bun test`. Run affected checks during iteration and group broad mandatory checks in one final pass.
- Use isolated homes and existing fixtures for manual verification. Real provider messages, if needed, use an explicitly selected cheap model and minimal calls.
- Push to the existing branch in Nacho's fork without opening a PR. Company MCP mapping and live verification occur on Nacho's other computer.

## Review Focus

1. Opaque IDs containing slashes or Unicode, and repository IDs differing only in case, must round-trip through selection and RPC without GitHub parsing (Tasks 1 and 3).
2. The same login on two services must not inherit GitHub's viewer relationships or share pins and cached details (Tasks 2 and 3).
3. Missing GitHub authentication must not suppress successful mod-source rows or force the entire page into the GitHub setup state (Task 4).
4. A source withdrawn and registered again before an old read finishes must reject the old result and keep the new generation's data (Tasks 2 and 3).
5. An acknowledged comment followed by a failed refetch must show mutation success and a refresh warning, with exactly one remote write (Task 5).

## File Boundaries

| Unit                 | Files and responsibility                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Public data protocol | New `packages/contracts/src/modPullRequests.ts`; source, item, request, result and capability schemas                      |
| Worker-facing API    | Existing `apps/server/src/mods/skill/types/synara.d.ts`, `modApi.ts`, `modProtocol.ts`; registration calls and typed hooks |
| Source execution     | New `apps/server/src/mods/modPullRequestSources.ts`; registrations, validation, generation ownership, request scheduling   |
| Local pins           | New `apps/server/src/mods/modPullRequestPins.ts`; atomic, source-aware persistence                                         |
| RPC wiring           | Existing contracts `mods.ts`, `rpc.ts`, `ws.ts`, `ipc.ts`; ModHost, `wsRpc.ts`, web `wsNativeApi.ts`                       |
| Page data            | New web `components/codeReview/codeReview.logic.ts`, `useCodeReviewSources.ts`, and `lib/modPullRequestQueryOptions.ts`    |
| Mutations/cache      | New web `lib/modPullRequestMutationOptions.ts`, `modPullRequestCache.ts`; per-source invalidation and acknowledgements     |
| Native presentation  | Existing GitHub inbox/list/detail primitives, with a new `components/codeReview/ModPullRequestDetailPanel.tsx` adapter     |
| Authoring            | Existing shipped skill and `docs/mods.md`, plus new fixture example `native-pr-source`                                     |

Keep source execution out of the already large `modManager.ts`: that file only delegates calls and provides the current worker generation. Do not create a second copy of native list/detail markup.

### Task 1: Define the Service-Neutral Data Protocol

**Files:**

- Create: `packages/contracts/src/modPullRequests.ts`, `modPullRequests.test.ts`.
- Modify: `packages/contracts/src/index.ts`.
- Modify: `apps/server/src/mods/skill/types/synara.d.ts`, `apps/server/src/mods/modApi.ts`.

**Interfaces:**

- `PullRequestSourceRef`: `{ kind: "github" } | { kind: "mod"; modId: string; sourceId: string }`.
- `ModPullRequestSourceDefinition`: `{ id: string; title: string; capabilities?: ModPullRequestCapabilities }`.
- `ModPullRequestCapabilities`: optional `diff`, `timeline`, `comment` booleans, `actions: PullRequestAction[]`, and `mergeMethods: PullRequestMergeMethod[]`; decoding defaults are false/empty.
- `ModPullRequestSourceSummary`: `{ source: ModPullRequestSourceRef; title: string; capabilities; revision: string }`. `ModPullRequestSourceRef` is the mod variant of `PullRequestSourceRef`; revision is a fresh opaque token for each registration generation.
- `ModPullRequestIdentity`: `{ repository: string; itemId: string }`; optional numeric `displayNumber` belongs to presentation data, not identity.
- `ModPullRequestListEntry`: identity, title, HTTP(S) URL, state, draft state, author, branches, timestamps, counts, labels, assignees, viewer relationships, and `projectIds`. Unknown scalar metadata is nullable; absent project IDs decode to `[]`.
- `ModPullRequestDetail`: entry fields plus body, reviewers, checks, comments, commits, incomplete/truncated flags, mergeability, and per-item merge methods. Optional collections stay nullable when unknown.
- `ModPullRequestListResult`: `{ items; nextCursor: string | null; totalCount: number | null; viewer: string | null }`.
- `ModPullRequestMutationResult`: `{ ok: true; mergeOutcome?: "merged" | "enqueued" | null }`.
- `ModsPullRequestListInput`: flat `modId`, `sourceId`, `state: "open" | "closed"`, `sort: "created" | "updated"`, nullable cursor, optional limit.
- Detail/diff/comment/action/pin inputs use `modId`, `sourceId`, repository and item ID. Detail adds `forceRefresh?`; comment adds body; action adds action and merge method; pin adds `isPinned`.
- Define `ModsPullRequestListResult` and `ModsPullRequestDetailResult` as host-decorated results with source reference, revision, resolved local project contexts, and local pin state. The mod supplies neither origin nor workspace paths.
- `ModsPullRequestSetPinnedResult` echoes the validated mod source/item identity and the resulting `isPinned` value. The diff result reuses `PullRequestDiffResult`; comment/action results reuse `ModPullRequestMutationResult`.
- `ModApi.pullRequests` exposes `registerSource(definition)`, `unregisterSource(sourceId)`, and `invalidate(sourceId?)`, all returning `Promise<void>`.
- `ModEvents` adds `pullRequests.list/detail/diff/comment/action` with local `sourceId` and the corresponding input/result fields; handlers use the existing matcher convention.

- [ ] Write schema tests named `accepts opaque item identities`, `preserves unknown metadata`, `defaults optional capabilities`, and `rejects invalid links and excessive pages`.
- [ ] Assert `itemId: "review/A-α"` and repository `"Team/Repo"` decode unchanged; a non-HTTP(S) display URL and a 501-item page fail; list input limit omission yields 100 and values above 500 fail.
- [ ] Run `bun run --cwd packages/contracts test src/modPullRequests.test.ts`; confirm failures describe missing schemas, not a broken fixture.
- [ ] Implement the schemas and matching worker-facing interfaces. Reuse existing actor/state/check/comment/commit/diff types, and validate all display link fields. Do not modify existing GitHub RPC shapes.
- [ ] Run the new tests and `bun run --cwd packages/contracts test src/pullRequests.test.ts src/githubInbox.test.ts`; require all selected tests to pass.
- [ ] Commit the protocol and type reference as `feat(mods): define generic pull request source contracts`.

### Task 2: Execute Sources Through the Existing Mod Host

**Files:**

- Create: `apps/server/src/mods/modPullRequestSources.ts`, `modPullRequestSources.test.ts`, `modPullRequestPins.ts`, `modPullRequestPins.test.ts`.
- Modify: `apps/server/src/mods/modManager.ts`, `modProtocol.ts`, `Services/ModHost.ts`, `Layers/ModHost.ts`, `modManager.test.ts`.
- Modify: `packages/contracts/src/mods.ts`, `rpc.ts`, `ws.ts`, `ipc.ts` and associated RPC tests.
- Modify: `apps/server/src/wsRpc.ts`, `apps/web/src/wsNativeApi.ts`, `wsNativeApi.test.ts`, `wsTransport.test.ts`.

**Interfaces:**

- `ModPullRequestSources` provides `register(modId, generation, definition, invoke)`, `unregister(modId, sourceId)`, `withdrawMod(modId)`, `summaries(modId)`, and typed async `list/detail/diff/comment/action/setPinned` methods.
- `invoke(event, input): Promise<unknown>` runs matching hooks only in the registered owner's current worker. Missing matching handlers fail explicitly, rather than returning an empty successful page.
- `ModPullRequestPins` provides `load()`, `isPinned(source, identity)`, `setPinned(source, identity, value)`, and `removeMod(modId)`; saves use an ordered atomic write to `<mods dataDir>/pull-request-pins.json`.
- Add `pullRequestSources: ModPullRequestSourceSummary[]` to `ModSummary`, with a decoding default of `[]`, and a stream event `{ type: "pullRequestsInvalidated"; modId; sourceId: string | null }`. Update the existing typed mods snapshot fixtures in `modsStore.test.ts` and `modsSnapshot.logic.test.ts` with the additive field.
- Extend `NativeApi.mods.pullRequests` and `ModHostShape.pullRequests` with the six typed request methods. Add flat RPC names `mods.pullRequestsList`, `mods.pullRequestsDetail`, `mods.pullRequestsDiff`, `mods.pullRequestsComment`, `mods.pullRequestsAction`, `mods.pullRequestsSetPinned` through the existing mods group.

- [ ] Add host tests `dispatches only to the owning mod`, `rejects unsupported operations before dispatch`, `limits sources and concurrent reads`, `rejects invalid results and project associations`, and `preserves acknowledgement independently of refresh`.
- [ ] Add lifecycle tests `discards a slow result after re-registration`, `withdraws sources on stop and trust invalidation`, and `keeps pins through reload but removes deleted mod pins`.
- [ ] Use two fixture sources with the same repository/item ID and different details; assert the request log contains only the selected owner's hooks. Run five suspended reads and assert only four enter their handlers until one finishes; registering an eleventh source fails.
- [ ] Run `bun run --cwd apps/server test src/mods/modPullRequestSources.test.ts src/mods/modPullRequestPins.test.ts`; confirm the intended initial failures.
- [ ] Implement the registry, generation guard, per-source four-read queue and identical-read single flight. Serialize writes per item, never deduplicate or retry them. Reuse worker budgets and reject stale results before caching or publishing.
- [ ] Add the three `pullRequests.*` entries to `MOD_API_METHODS`; delegate manager API calls and targeted hook requests to the registry. Integrate source withdrawal with every existing stop/reload/remove path and include registration metadata in snapshots.
- [ ] Validate result identity, link fields, page limits, state membership, live project associations, requested action and merge method. A merge request requires an advertised method; per-item restrictions remain subject to the backing service's final check.
- [ ] Wire services, contracts, RPC and the web facade. Preserve `mcp_sign_in_needed` errors and the authoritative Beta gate on every request. Source queries expose data; enabling/trusting still follows existing owner-session rules.
- [ ] Add focused RPC/facade tests for all six method names, refusing mod-source calls on Stable, and unchanged built-in GitHub calls. Run the affected contracts RPC tests, server mod tests, and web facade tests.
- [ ] Commit as `feat(mods): host registered pull request sources`.

### Task 3: Add Source-Aware Page Data and Selection

**Files:**

- Create: `apps/web/src/components/codeReview/codeReview.logic.ts`, `codeReview.logic.test.ts`, `useCodeReviewSources.ts`, `useCodeReviewSources.browser.tsx`.
- Create: `apps/web/src/lib/modPullRequestQueryOptions.ts`, `modPullRequestQueryOptions.test.ts`, `modPullRequestCache.ts`, `modPullRequestCache.test.ts`.
- Modify: `apps/web/src/components/githubInbox/githubInbox.logic.ts`, `githubInbox.logic.test.ts`, `apps/web/src/mods/useModsBridge.ts`, `modsSnapshot.logic.ts`, `modsSnapshot.logic.test.ts`.

**Interfaces:**

- `codeReviewSourceKey(ref): string` uses `"github"` or `"mod:<modId>:<sourceId>"`; `parseCodeReviewSourceKey(value)` accepts only those validated forms.
- `codeReviewItemKey(source, identity): string` serializes the full source plus the exact repository and item ID as a JSON tuple. It never lowercases mod identities.
- `CodeReviewRow` holds source reference, normalized presentation data, resolved project contexts and local pin state. Built-in GitHub rows retain their original typed item for existing issue/detail/action paths.
- `toCodeReviewRows(githubResult, modPages): CodeReviewRow[]` normalizes each source independently, including its own viewer, and preserves GitHub issues.
- `useCodeReviewSources({ state, sort, origin })` returns rows, per-source notices, loading state, `refresh()`, and per-source next-page controls. Only the mounted Code review page consumes this hook.
- Mod query keys start with `['mod-pull-requests', modId, sourceId]` and continue with operation, registration revision, identity and projection arguments. Existing GitHub query keys remain unchanged. Generate new opaque revisions after server restart as well as reload so an earlier process's results cannot appear current.
- Extend inbox search with `origin?`, `selectedSource?`, `selectedItemId?`. Old links still resolve GitHub from their existing project/repository/number fields. Clear all added selection fields with the existing detail-close helper.

- [ ] Add tests `round-trips opaque selections`, `separates source identities and viewers`, `sorts unknown dates without fabricating values`, `preserves legacy GitHub links`, and `ignores data from a withdrawn source generation`.
- [ ] Assert two rows with item ID `"42"` survive, `"Team/Repo"` differs from `"team/repo"` for mod sources, and a coincident GitHub login does not set another source's authored/involved flags.
- [ ] Add a hook browser test `fetches on demand and follows opaque pagination`: discovery and a hidden page make zero mod list calls; opening the page makes one; explicit Refresh makes another; Load more passes the exact cursor; no timer starts a periodic fetch.
- [ ] Run the new logic/cache/query tests, then the focused browser test; confirm initial failures arise from absent source-aware behavior.
- [ ] Implement native-page query ownership and aggregation. Catch failures per source; deduplicate by full identity, retain cursor/total information, and only apply text/project/involvement filters after source normalization.
- [ ] Extend the mods bridge to invalidate matching query prefixes on source events and sign-in completion, remove withdrawn-generation data, and drop the affected mod's sensitive reads on sign-out. Invalidation of inactive queries must not fetch them.
- [ ] Run these tests plus existing `githubInbox.logic.test.ts` and `modsSnapshot.logic.test.ts`; require selected unit and browser tests to pass.
- [ ] Commit as `feat(code-review): query and select mod pull requests`.

### Task 4: Render Mod Items in the Existing Code Review Page

**Files:**

- Create: `apps/web/src/components/codeReview/ModPullRequestDetailPanel.tsx`, `ModPullRequestDetailPanel.browser.tsx`.
- Modify: `apps/web/src/components/githubInbox/GitHubInbox.tsx`, `GitHubInboxFilterBar.tsx`, `GitHubInbox.browser.tsx`, `apps/web/src/routes/_chat.pull-requests.index.tsx`.
- Modify: `apps/web/src/components/pullRequest/PullRequestList.tsx`, `PullRequestRow.tsx`, `PullRequestDetailPanel.tsx`, `GitHubItemPageLayout.tsx`, `PullRequestSummaryTab.tsx`, `PullRequestCodeTab.tsx`, `PullRequestTimelineTab.tsx`, `PullRequestActions.tsx` and affected presentation tests.
- Modify: `apps/web/src/components/settings/ModsSettingsPanel.tsx`.

**Interfaces:**

- `ModPullRequestDetailPanel({ source, identity, pageHost, onBack, onClose })` reads the typed mod query and passes presentation data and callbacks to shared native detail bodies.
- Generalize presentation props to permit nullable metadata and absent local project/workspace context. Existing `PullRequestDetailPanel` supplies a GitHub adapter over these same bodies.
- The inbox consumes `CodeReviewRow`, selecting the legacy GitHub detail/issue adapter or the mod adapter by explicit source kind. Origin choices come from registered metadata, not hardcoded service names.

- [ ] Extend the native inbox browser fixture with two mod sources, one opaque ID, one row without a local project, and different capabilities.
- [ ] Add tests `opens a mod item in native main detail`, `shows mod rows when GitHub is unauthenticated`, `hides unsupported tabs and remote actions`, and `keeps responsive list-detail navigation`.
- [ ] Assert the native page shows fixture mod rows while GitHub returns `gh-not-authenticated`; selecting a row opens its summary without replacing the sidebar or displaying a chat transcript. Open Changes and assert exactly one diff request for that item.
- [ ] Run the affected browser tests and confirm the new assertions fail on the current page.
- [ ] Connect source data, origin filter and source-aware selection to the existing route. Reuse or extract native row/header/summary/diff/timeline bodies instead of copying their markup into the adapter.
- [ ] Render useful unknown and partial-data states, source notices and unavailable-source detail. Show existing MCP Sign in controls using the mod's actual pending server metadata; support returning after successful authentication.
- [ ] Derive tabs and action controls from advertised capabilities and item state; select the first allowed merge method instead of assuming `merge`. Display registered sources in Mods settings for author debugging.
- [ ] Run the native inbox, mod detail and existing pull request row/browser tests, plus `bun run --cwd apps/web test src/uiFontSize.test.ts`; require all selected checks to pass.
- [ ] Commit as `feat(code-review): reuse native views for mod sources`.

### Task 5: Connect Mutations, Local Pins and Agent Context

**Files:**

- Create: `apps/web/src/lib/modPullRequestMutationOptions.ts`, `modPullRequestMutationOptions.test.ts`.
- Modify: `apps/web/src/components/codeReview/ModPullRequestDetailPanel.tsx`, `apps/web/src/components/pullRequest/PullRequestCommentComposer.tsx`, `GitHubItemAgentActions.tsx`, `githubItemAgentContext.ts`.
- Modify: `apps/web/src/components/githubInbox/useGitHubInboxSidechat.ts`, `GitHubInboxSidechatDock.tsx`, `GitHubInboxAgentActions.browser.tsx`.
- Modify: `packages/contracts/src/orchestration.ts`, `orchestration.test.ts`, `apps/web/src/lib/pullRequestContext.ts`, `pullRequestContext.test.ts`, `components/chat/environment/environmentPullRequest.logic.ts`, `environmentPullRequest.logic.test.ts`, `storeSelectors.ts`, `lib/sidechatCreation.ts` and associated sidechat tests.
- Modify: `apps/server/src/orchestration/decider.standaloneSidechat.test.ts` and any context serialization boundary that the additive context variant touches.

**Interfaces:**

- `modPullRequestCommentMutationOptions(queryClient)`, `modPullRequestActionMutationOptions(queryClient)`, and `modPullRequestSetPinnedMutationOptions(queryClient)` route only to the mod facade and invalidate only matching source data after acknowledgement.
- Add a `ThreadSidechatContext` union variant with `kind: "code-review-item"`, full mod source reference, repository, item ID, URL and title. Keep the existing `github-item` variant and serialized payloads compatible.
- `createModPullRequestContextDraft(source, detail)` produces the native context-card data with explicit origin and opaque ID. Context serialization, deduplication and sidechat selectors use that full identity.
- Send to agent requires a valid selected project and creates a normal contextual draft without passing a mod URL into `useStartGitHubItemThread`'s GitHub checkout path. Ask keeps the current approval-required runtime behavior.

- [ ] Write tests `keeps mutation success when detail refresh fails`, `isolates overlapping source pins`, `round-trips generic agent context`, and `avoids GitHub checkout for a mod item`.
- [ ] Assert one acknowledged comment produces one write even if detail rejects; the UI retains success and shows the failed refresh separately. Pinning source A must leave source B and GitHub unchanged.
- [ ] Add a browser test for Ask and Send to agent with a selected valid project: its context keeps the source and opaque item ID, its runtime requests approval, and no GitHub preparation call occurs.
- [ ] Run the new mutation/context tests and the native agent-action browser fixture; confirm initial failures describe the intended missing behavior.
- [ ] Connect confirmed native action controls and comment creation to source methods, preserving per-item pending state. Apply local pins to current source pages and durable host state; never reuse GitHub pin cache helpers on mod identities.
- [ ] Extend context and sidechat consumers additively. Filter by full origin and item identity, preserve old cards/selectors, and make persisted mod references inert for resolution on Stable. Keep unavailable-source cards readable with an unavailable notice.
- [ ] Run the mutation/context/sidechat tests and existing GitHub comment/action/pin tests; require selected checks to pass.
- [ ] Commit as `feat(code-review): route mod actions and agent context`.

### Task 6: Ship the Authoring Guide and Verify the Whole Flow

**Files:**

- Modify: `apps/server/src/mods/skill/SKILL.md`, `apps/server/src/mods/skill/types/synara.d.ts`, `apps/server/src/mods/modSkill.test.ts`, `docs/mods.md`.
- Create: `apps/server/src/mods/skill/examples/native-pr-source/.synara-mod/mod.json`, `hooks/hooks.json`, `hooks/register.ts`, `hooks/data.ts`.
- Modify: `apps/server/src/runtimeDependencySmoke.ts`.
- Temporary, uncommitted evidence fixture: `apps/web/src/components/codeReview/zzModPullRequestSourcesScreens.browser.tsx`.

**Interfaces:**

- `native-pr-source` registers `team-reviews`, supplies fixture list/detail/diff, and demonstrates supported comment/action hooks without a sidebar or dock view. It requires neither company access nor a provider login.
- The skill includes a documented MCP variant whose illustrative tool names and payload mapping stay inside the example mod. Explain discovery with `$.mcp.tools`, capability declaration, cursor handling, invalidation, sign-in and source errors.
- Migration instructions retain an existing mod's MCP/OAuth configuration, move its reads into the typed hooks, and replace its redundant sidebar registration with a native source.

- [ ] Add a skill test `loads and queries the native source example` that typechecks the shipped example, enables it in a real worker, and queries list/detail/diff through the host with no registered custom views.
- [ ] Run `bun run --cwd apps/server test src/mods/modSkill.test.ts` and confirm that the new example assertions initially fail.
- [ ] Implement the example, reference and guides. Distinguish custom sidebar/dock views from native PR sources; keep the existing view examples. Add a compiled-worker smoke request for the generic source.
- [ ] Run the skill tests and review every documented type, method, hook, field and example against the implementation. Review the new runtime/UI dispatch code for service-name or service-URL branching; company-specific configuration belongs only to an authored mod.
- [ ] Run one final pass from the worktree root: `bun run fmt:check`, `bun run lint`, `bun run typecheck`, and `bun run test`. All must pass; isolate any failure with the smallest affected test before deciding whether it blocks the change.
- [ ] Run the affected browser fixtures in one pass with `bun run --cwd apps/web test:browser <affected.browser.tsx paths>`. Build with `bun run --cwd apps/server build`, then run `node apps/server/dist/runtimeDependencySmoke.mjs`; never launch or import `dist/index.mjs` for verification.
- [ ] Run `bun run windows-runtime:check` if process boundaries changed; run `bun run migrations:check` only if implementation required a database migration. Pins in this plan use a JSON state file and require none.
- [ ] Capture before/after evidence using existing native fixtures, with English UI/demo copy in light and dark themes. Inspect the images and remove the temporary harness before committing.
- [ ] Commit the guide and examples as `docs(mods): teach native pull request sources`, including any final verified changes. Fetch upstream and confirm the retained branch is based on its latest main before pushing.
- [ ] Push the verified commits to `origin synara/plan-synara-plugin-system`. Verify the remote head matches; do not create a PR.
- [ ] Report tests, fixture screenshots and remaining live verification honestly. Supply Nacho a migration prompt for his real mod using only the now-published API.

## Execution and Review

Recommended execution is Native: the host protocol, cache identity and native presentation tasks depend closely on each other's interfaces, so one implementer can keep them consistent without repeated handoffs. Finish with one fresh whole-branch reviewer, using the execution workflow's review process, before reporting completion.

An alternative is Subagent-driven execution with a separate implementation and review per task. Its additional independent review comes with more context handoffs and cost. Nacho selects the method after reviewing this plan.
