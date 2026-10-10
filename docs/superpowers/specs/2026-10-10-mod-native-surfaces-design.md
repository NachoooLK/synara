# Mods in Environment, Tasks and Inbox

Status: proposed design, awaiting review. No product implementation has started.

Base: `upstream/main` `3ad0bb3de` (2026-10-10). Branch:
`synara/plan-synara-plugin-system`. Its existing 17 commits have been preserved on
this base; the previous head is saved as
`backup/mods-before-menu-extension-20261010`.

## Intended outcome

Nacho wants mods to contribute content to the chat's Environment panel and to
the existing Tasks and Inbox pages. Tasks and Inbox must also accept external
tasks and notices in their native lists. Custom panels alone do not satisfy this
request. The API must be useful to any mod, independent of Paraty, Bitbucket,
Codex or a particular MCP service.

This is three independently deliverable parts:

1. Native view slots in Environment, Tasks and Inbox.
2. Registered sources of tasks in Tasks and the existing Inbox to-do section.
3. Registered sources of notices in Inbox.

Each part gets its own implementation plan and validation. The complete request
is finished when all three parts and their authoring examples are validated.

## Current behavior and integration points

- `ModViewSite` accepts `sidebar`, `dock`, `band` and `header`.
- `ModManager` registers views, validates their JSX trees, owns their handlers
  and publishes snapshots. `ModViewHost` renders and dispatches actions on the
  originating window. These mechanisms already support reloads and trust.
- `EnvironmentPanel` composes native labeled/collapsible sections and rows.
  It stays mounted during transitions, so rendering extensions must explicitly
  follow its open state.
- `TasksView` displays local `Todo` records with `TodoId` identities, and
  `useTodos` maintains their mutation/event cache. A foreign service's item ID
  cannot be passed through that local mutation API.
- `InboxView` combines attention/activity rows, local to-dos and recap cards.
  It has no mod notice source today.
- Code review already has registered sources with generation boundaries,
  on-demand reads, opaque identities, capabilities and explicit invalidation.
  The new sources follow that established ownership model.

## Chosen approach

Use registered external sources and merge normalized data at the native UI
boundary. Local items keep their existing owner, while mod items retain the
identity of their source and route actions to that source. Rendering primitives
are shared where their presentation matches.

Importing every external item into the local Todo store would also populate
Tasks, but requires synchronization rules for deletion, remote edits and
ownership, and can leave duplicates when a mod is removed. Registered sources
fit the existing Code review integration and keep the backing service
authoritative.

Custom views remain useful for dashboards and controls. They are supported
alongside native sources, rather than being used to represent foreign items as
unrelated parallel task/inbox lists.

## Part 1: view slots

### Public contract

Extend `$.ui.view` with three site values:

```ts
await $.ui.view({
  id: "service-status",
  site: "environment",
  title: "Service status",
  icon: "bell",
  refreshOn: ["threads", "projects"],
});
// Also supported: site: "tasks" and site: "inbox".
```

Keep the existing registration/render/handler interface. Update contracts,
runtime validation, published types and globals, Settings labels and tools that
describe views together. Existing site values and their semantics remain valid.

### Placement and context

- `environment`: a native labeled, collapsible section at the end of the
  Environment card. It receives the card's thread/project context. An empty view
  creates no section or separator. Section titles and disclosure controls are
  host-owned, and the supplying mod is identifiable.
- `tasks`: supplemental sections below the page heading and before the native
  task list. Each view has a host-owned title and native spacing.
- `inbox`: supplemental cards in the page's existing responsive card layout.
  They must work alongside the attention and recap columns.
- Global Tasks/Inbox views receive `threadId: null` and `projectId: null`.
  They do not accidentally inherit the last visited chat's context.
- Multiple views are ordered deterministically by mod ID and then view ID.
  Disclosure state is keyed by that identity and belongs to the window.

Adapt the existing `Row` and `Section` elements to Environment's native row and
section primitives when used there. Add a native `Disclosure` JSX element with
`title`, optional `icon` and optional `defaultOpen`, and children. This enables
individual expandable details without mods implementing their own disclosure
state or inaccessible buttons. It uses the existing accessible Collapsible
components and motion policy. It is available to the other view sites too.

The host preserves font settings, keyboard focus and responsive width. Handlers
continue to be disabled while pending. Errors and MCP sign-in requirements are
visible within the contributing section and in Settings; one failed view does
not remove another mod's content.

### Demand

Only active surfaces render. In particular, closing Environment suppresses
new render calls despite its animation keeping the panel mounted. Opening it
renders current context/data. Route changes unmount Tasks/Inbox contributions.
An empty or inactive surface does not start a background poller.

## Shared source rules for Parts 2 and 3

Each family has `registerSource`, `unregisterSource` and `invalidate`. Sources
are registered with stable metadata in `mod.start`. The mod returns normalized
data from matched request hooks, using `$.mcp` when an external service is
needed. Registration performs no service reads.

- Identity is `(family, modId, sourceId, itemId)`; item IDs are opaque,
  case-sensitive and are never cast to `TodoId` or `ThreadId`.
- Each registration carries a host revision bound to the running mod
  generation. Identical metadata within that generation preserves pending
  reads. Actual metadata changes, reloads, disabled mods and lost trust withdraw
  stale results and handlers.
- Maximum ten sources per family per mod; maximum 500 items per response,
  four concurrent reads per source and one pending mutation per item.
- Coalesce identical in-flight reads. Use the existing hook deadline and source
  error/logging conventions. Extract a narrow shared scheduler only if the new
  families require the same implementation; do not rewrite PR adapters.
- Invalidations refresh mounted, active queries. Queries also refresh on
  surface activation and explicit user refresh; they do not add periodic reads.
- Cursors belong to the source. Requested state, sort and limit are part of the
  query key. Stable source/item identity breaks timestamp ties when merging.
- Unknown dates, identities and metadata remain nullable. Unknown timestamps
  sort after known ones. A source failure is displayed with any last good
  cached data marked stale; authentication failures clear affected private
  cached data and display that source's sign-in action.
- Project associations refer to existing Synara projects and are resolved by
  the host. Unknown project IDs do not manufacture folders or paths.
- HTTP(S) links are validated at the boundary. Titles, descriptions, notices
  and action labels are reference data, not instructions to an agent.
- Source errors leave local data and other sources usable. Failed reads never
  become successful empty pages.
- Writes are triggered by an explicit user action, dispatched once, and
  return success only after acknowledgment. Unknown outcomes are surfaced
  without automatic retry. Withdrawal during a write can report that the
  remote operation may already have completed; read failures do not use that
  warning.
- Enforce the Beta-only mods boundary on the server and web. Stable continues
  to use local Tasks/Inbox and does not invoke saved mod sources or handlers.
- Source registrations appear in the mod snapshot and Settings. New source
  arrays decode as empty when an older server omits them. Use the existing
  source-session admission rules, and respect the connected server's Tasks
  availability rather than bypassing its legacy Kanban fallback.

## Part 2: Tasks sources

### Public API and hooks

```ts
await $.tasks.registerSource({
  id: "team-tasks",
  title: "Team tasks",
  capabilities: {
    create: false,
    editableFields: [],
    actions: ["complete", "reopen"],
  },
});
await $.tasks.invalidate("team-tasks");
```

Hooks matched by `{ sourceId }`:

| Hook           | Input                                                                       | Result                                       |
| -------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| `tasks.list`   | `state: open/done`, `sort: updated/created/due/priority`, `cursor`, `limit` | `items`, `nextCursor`, nullable `totalCount` |
| `tasks.detail` | `itemId`, `forceRefresh`                                                    | Detail with the requested identity           |
| `tasks.create` | `title`, optional `notes`, `priority`, `dueDate`, `projectId`               | Acknowledged created item with its identity  |
| `tasks.update` | `itemId`, a validated patch                                                 | Acknowledged updated item                    |
| `tasks.action` | `itemId`, `action: complete/reopen/delete`                                  | `{ ok: true }` after acknowledgment          |

List/detail are required. The other hooks are advertised by capabilities, which
default to read-only. `editableFields` can contain `title`, `notes`, `priority`,
`dueDate` and `projectId`. Each item can further restrict source capabilities;
it cannot enable actions the source does not offer. The host validates actions
and patches before dispatch, and the backing service remains responsible for
authorization and state transitions.

### Normalized data

Required fields: `itemId`, `title`, `state: open/done`.

Optional fields: `notes`, `url`, `priority` (the existing Todo priority values),
`dueDate` (the existing calendar-day format), `createdAt`, `updatedAt`,
`completedAt`, `projectId`, `assignee` (stable ID and nullable visible name),
and `status: todo/running/needs/review/stopped/done` with nullable `statusText`.
Detailed bodies are plain text in the initial contract, matching local task
notes. State and status are validated consistently; a done item has done status.
Reuse the local Todo limits for titles, notes, priority and calendar-day dates.

The service status describes external work. It is not permission to approve a
Synara tool or invent a linked agent chat. Remote thread links and delegation
are not inferred from foreign IDs.

### Native presentation

- Merge local and external rows in Tasks, using the existing grouping rules:
  attention first, then work in progress, remaining open tasks, and completed
  tasks. Reuse row/card primitives and extend the source-aware view model.
- Keep the visible source label on external rows/details. A source selector
  offers all, local, or an individual source. Search covers title, notes,
  assignee name/ID and source title. Existing due/priority ordering works on
  normalized values.
- Details open the existing task-card presentation, adapted to a source-aware
  identity. Enabled edit/completion/delete controls dispatch to the correct
  owner. Read-only tasks remain viewable.
- Selection/deep links carry the full source identity. Opaque item IDs are
  encoded as data rather than interpreted as local task IDs or route fragments.
  Source search filters the pages already loaded; continuation remains visible
  when more source data can be requested. It does not claim a remote full-text
  search that the list contract does not offer.
- Native quick-add defaults to local tasks. Source selection enables creation
  only for a source advertising `create`.
- Show external tasks relevant to today in Inbox's existing to-do section,
  using the same query cache and completion semantics. Mounting Inbox is an
  active consumer of those task sources; hidden pages do not query them.
- Local agent delegation retains its existing behavior. External-task details
  offer an explicit “Send to agent” reference containing the full source
  identity and quoted task context. It does not claim the remote task has been
  assigned, create a duplicate local Todo, or automatically complete it.
- When a selected source disappears, its detail identifies it as unavailable
  and offers no stale actions. Local items remain interactive.

## Part 3: Inbox notice sources

### Public API and hooks

```ts
await $.inbox.registerSource({ id: "build-notices", title: "Build notices" });
await $.inbox.invalidate("build-notices");
```

Hooks matched by `{ sourceId }`:

| Hook           | Input                                      | Result                                       |
| -------------- | ------------------------------------------ | -------------------------------------------- |
| `inbox.list`   | `sort: updated/created`, `cursor`, `limit` | `items`, `nextCursor`, nullable `totalCount` |
| `inbox.detail` | `itemId`, `forceRefresh`                   | Notice detail with the requested identity    |
| `inbox.action` | `itemId`, advertised `actionId`            | `{ ok: true }` after acknowledgment          |

List/detail are required. An action is available only when advertised by the
source and the current item. Source action definitions have a bounded stable
ID, a visible label, a `destructive` flag and a `requiresConfirmation` flag;
the host always confirms destructive actions. The default source has no remote
actions.

### Normalized data and local state

Required fields: `itemId`, `title`, and `category:
attention/progress/review/error/info`.

Optional fields: `summary`, `body` (detail Markdown), `createdAt`, `updatedAt`,
`projectId`, `url`, `icon`, and a typed target referencing an existing Synara
thread or a full task/PR source identity. Targets are validated by their owner.
Icons use the existing allowlist. External bodies use the shared safe Markdown
renderer.
Limit titles to 500 characters, summaries to 2,000 and detail bodies to 65,536;
allow at most 20 source action definitions. Reject malformed payloads at the
source boundary before merging them into native lists.

Read/unread and dismiss states belong to Synara, persisted on the server by
the full notice identity and broadcast to connected windows. They are local
Inbox preferences, not an implicit write to the external service. Dismissal
removes a notice from the active Inbox, with a dismissed view offering restore.
Sources use a new item ID for a distinct occurrence that should notify again.
That prevents refresh/reload from resurrecting the same dismissed notice.

### Native presentation

- Merge notices into the existing Inbox attention/activity groups by category
  and timestamp, using the native row/group presentation. Info notices get a
  native Notices group. Notices are not presented as provider recap statistics.
- Counts include notices in their own matching group; an external progress
  notice does not increase Synara's count of running agent chats.
- Counts derived from source items cover loaded data. The host does not present
  an unknown total or inactive source as a confirmed zero, or poll sources only
  to manufacture a navigation badge.
- Clicking opens native detail and the validated target/open-link control.
  Mark read/unread, dismiss/restore and supported remote actions are native
  controls with the source visible.
- A source selector filters external notices without hiding unrelated local
  task/attention content. “Mark all read” covers loaded active notices and the
  existing unread-thread behavior; it performs no hidden pagination or remote
  action.
- Share the task cache between Tasks and Inbox, but keep notice identities and
  state separate from task completion. A build notice linked to a task is still
  a notice; dismissing it does not complete the task.

## Documentation and examples

Update `docs/mods.md`, the shipped `synara-mods` skill, its types/globals and
the mod tools' source summaries in the part that introduces each capability.
The existing skill is a product-owned asset and stays in the repository; this
task does not create a separate personal skill.

Add small standalone examples using `$.store` for demo data and no credentials:

1. `environment-status`: native rows, expandable details and a dock-opening
   action, plus a small Tasks/Inbox supplemental view.
2. `native-task-source`: read-only and editable demo tasks, paging, detail and
   acknowledged completion/reopen behavior.
3. `native-inbox-source`: actionable and informational notices, detail,
   target references and one acknowledged fixture action.

Use English fixture content for screenshots. Clearly label demo items. Extend
the existing example typecheck/load tests instead of adding a new harness.

## Verification and acceptance

For each part, use failing focused tests during implementation and one final
required-check pass. Contract/runtime changes require the relevant broader
cross-package suite at that part's final checkpoint. Browser checks reuse
existing Vitest/Playwright fixtures; real provider calls are unnecessary.

Required acceptance cases:

- Valid/invalid site, source, identity, cursor and action payloads.
- Environment closed versus open; empty results leave no chrome; multiple
  mods and disclosure keyboard/focus behavior; narrow layouts and configured
  font sizes.
- Local/external Tasks merge, search/order/paging, detail, capability-aware
  create/edit/completion, read-only rows and Inbox's today subset.
- Notice grouping, provenance, targets, read/dismiss persistence and window
  events; refresh/reload never resurrects a dismissed occurrence.
- Identical registration during a read; invalidation during a read; withdrawal,
  reload, authentication change and stale-handler rejection.
- A source error while local data and a second source remain usable.
- Exactly one write on user action; unknown outcome and withdrawal during a
  write do not trigger a retry or report an unacknowledged success.
- Disabled/changed mods and Stable invoke no mod views or source hooks.
- Every example typechecks and actually loads; custom render checks do not
  substitute for native list/detail/action browser checks.

Finish each part with format, lint, types and required tests. Run migration
checks if durable Inbox state adds a database migration, and platform checks
if persistence crosses a new platform/process boundary. Capture before/after
native UI evidence with the existing fixtures. Report fixture validation
separately from any later live MCP adapter validation.

## Review checkpoint

Approve or amend this design before writing the first part's implementation
plan. Implement Environment/view slots first, task sources second, and notice
sources third. This ordering produces reviewable changes while retaining the
complete agreed scope.
