# Mod pull request sources in Code review

Date: 2026-10-10

Status: proposed design for written review. The on-demand, service-independent approach is
approved; implementation starts after this specification and its implementation plan are
reviewed.

Base: `upstream/main` at `6f54f53c6`, with the existing mods work through `bfce8bc21` on
`synara/plan-synara-plugin-system`.

## Outcome

A person opens Synara's existing **Code review** page and sees pull requests supplied by
enabled mods alongside the built-in GitHub items. Selecting a mod's pull request opens its
detail in the main page, using Synara's list, summary, changes, timeline, and action controls.
The mod supplies data and operations, rather than drawing another pull request interface in
the sidebar.

Nacho approved querying the mod on demand and explicitly requires a generic implementation.
The source interface must work with any mod and any backing service. MCP server names, tool
names, authentication configuration, service URLs, and response conversion belong to the mod.
The Synara runtime and native UI must contain no Paraty or Bitbucket dispatch rules.

The change includes the built-in mod authoring skill, its type reference, examples, public
documentation, and instructions for migrating an existing sidebar mod.

## Approach and ownership

Use registered pull request sources with typed request hooks. An alternative is having each
mod periodically publish a snapshot, but that introduces a second refresh schedule and still
needs request handlers for detail and actions. The registered-source approach keeps fetching
under the native page's control.

| Owner                    | Responsibility                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Mod                      | Register its sources, translate service responses, implement advertised operations |
| Mod host                 | Own registration and dispatch, validate data, enforce capabilities and lifecycle   |
| Code review              | Query visible sources, combine results, filter, select, and render native UI       |
| Existing GitHub services | Continue handling built-in GitHub reads and operations                             |
| Existing MCP client      | Handle the mod's declared transport, sign-in, and credentials                      |

The host calls a hook only in the mod that owns the requested source. These request hooks do
not run through the general chain of every enabled mod. They are separate from custom tools
exposed to agents and do not require the `tools` permission.

## Source API

Extend the existing `synara` type reference with:

- `$.pullRequests.registerSource(definition)`.
- `$.pullRequests.unregisterSource(sourceId)`.
- `$.pullRequests.invalidate(sourceId?)`, where omission invalidates this mod's sources.

A source definition contains a local `id`, a display `title`, and `capabilities`. IDs follow
the existing lowercase words joined by dashes convention, up to 64 characters. A running mod
may register up to ten sources. Registering an existing local ID updates its definition;
the mod cannot register or replace another mod's source.

List and detail are required. The capabilities fields are optional booleans `diff`,
`timeline`, and `comment`, plus optional arrays `actions` and `mergeMethods`. They describe
diff reading, timeline reading, comment creation, supported remote actions, and merge
methods respectively. Remote actions use the
existing native operations: `merge`, `ready`, `draft`, `close`, and `reopen`. An omitted
capability is unsupported. Generic registration does not imply that a service implements
GitHub stacks or GitHub-specific checkout and CI automation.

Add these typed hooks to `ModEvents`:

| Hook                   | Input                                                          | Result                                                                    |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pullRequests.list`    | Local `sourceId`, state, sort, cursor, limit                   | Normalized items, next cursor, optional total count, this source's viewer |
| `pullRequests.detail`  | Local `sourceId`, item identity, force-refresh flag            | Normalized detail                                                         |
| `pullRequests.diff`    | Local `sourceId`, item identity                                | Patch and truncation flag                                                 |
| `pullRequests.comment` | Local `sourceId`, item identity, comment body                  | Mutation acknowledgement                                                  |
| `pullRequests.action`  | Local `sourceId`, item identity, action, optional merge method | Mutation acknowledgement and optional merge outcome                       |

Matchers can select a local `sourceId`, following the existing `on(event, matcher, hook)`
convention. A source with timeline support returns comments and commits in detail; the
native UI presents that data in its Timeline tab. Capabilities govern both
the UI and authoritative host dispatch; calling a hidden operation directly through RPC
must still fail before invoking the mod.

For example, a mod can register `team-reviews`, implement `pullRequests.list` by calling
`$.mcp.json(...)`, and implement `pullRequests.detail` by another MCP call. Another mod can
implement the same hooks from its saved data. Neither requires a change to Synara.

## Identity and normalized data

Use an explicit source reference:

- Built-in GitHub: `{ kind: "github" }`.
- A mod source: `{ kind: "mod", modId, sourceId }`.

Each mod item has an opaque repository identifier and an opaque non-empty item ID. A numeric
display number is optional. Repository identifiers and item IDs are compared exactly for
mod sources; only the built-in GitHub adapter applies GitHub's repository normalization.
Do not require a GitHub URL, `owner/name` repository syntax, or numeric service identifier
from a generic source.

The full source reference, repository, and item ID form the identity used by list keys,
selection, detail and diff caches, mutations, pins, and agent context. Two services may both
have an item numbered 42 in a repository with the same name without sharing any state.
User-visible URLs are validated as HTTP(S) links, not used to infer the owning adapter.

Define service-neutral schemas in `packages/contracts`. List data includes identity, title,
URL, author, state, draft state, branches, timestamps, counts, labels, viewer relationships,
and optional local project associations. Detail adds description, reviewers, checks, comments,
commits, and merge availability. Reuse the existing actor, check, comment, commit, state, and
diff schemas where their semantics already fit.

Unknown metadata remains unknown: absent counts or timestamps must not become fabricated
zeroes or dates. Missing viewer information does not establish authorship or review requests.
The normalized viewer belongs to its source; GitHub's viewer login must never be applied to
another source's rows.

An external item can be reviewed without a local project association. The host validates
provided project IDs against live Synara projects. Project filters apply to associated
items, and project-dependent agent actions require a selected valid project. Never invent
a project ID or pass an external repository through GitHub's local inventory validation.

Keep existing GitHub RPC payloads and selection links compatible. Add source-aware contracts
and optional origin metadata where needed rather than changing the meaning of existing
GitHub identifiers. Adapt both kinds to common presentation data at the page boundary.

## Requests, caching, and pagination

Source discovery is metadata-only and is included in the existing mods snapshot. Discovering
sources or drawing navigation badges must not call the backing service.

The page requests the first list page when opened, when state or sort changes, or when the
person presses Refresh. The origin filter can select all sources, GitHub, or a registered
mod source. Text, involvement, and project filters operate on loaded normalized data.

A list request defaults to 100 items and permits at most 500. The returned cursor is opaque;
the native list offers Load more for sources with another page. Results carry truncation or
remaining-page information so the interface never reports a partial page as the complete
repository. Explicit totals may be shown; unknown totals stay unspecified.

Detail is fetched on selection. Diff is fetched when Changes is opened. Reads use the
existing short-lived query-cache pattern, with the full origin in the key. A force refresh
bypasses the relevant cached read. Identical concurrent reads collapse into one in-flight
request, and a source has at most four concurrent reads. Mutations are not deduplicated and
are serialized for one item.

Mod sources have no periodic polling. Refresh, successful mutation, completed sign-in,
registration changes, and `$.pullRequests.invalidate` can invalidate visible queries.
Inactive pages do not start MCP requests. Leaving a page or changing selection prevents stale
results from replacing the current selection. Reuse the existing worker hook limits,
including its 60-second wall-clock limit, and RPC interruption paths.

After a remote mutation is acknowledged, report its success separately from a later refetch
failure, following the existing GitHub mutation behavior. A successful remote mutation must
not be retried automatically just because refreshing its detail failed.

## Native UI and agent context

Reuse Code review's route and page layout. Extend its origin filter, row identity, selection,
query ownership, and data boundary. Reuse or extract the shared list rows, detail header,
summary, diff renderer, timeline, action confirmation, loading states, and responsive
list/detail behavior. Preserve the existing GitHub issues within Code review.

Source-aware selection is represented in the URL. Old GitHub links without an origin still
select GitHub. A mod selection retains its full source and opaque item ID, and survives a
reload without guessing the service from its URL. Back navigation and closing detail clear
all selection fields consistently.

List rows identify their origin, and the native page renders service-neutral labels for mod
items. Unsupported tabs and actions are absent. Availability from the selected item's state
can further restrict source-wide capabilities; a source's merge support does not mean every
listed pull request is mergeable.

Ask and Send to agent reuse native context presentation with explicit origin metadata. A
mod item can be attached to a conversation in a valid selected project without invoking
GitHub's branch preparation. GitHub-specific checkout, stacked merge, and automatic CI
repair continue using the built-in adapter. Never dispatch a mod URL to `gh` as a fallback.
This change does not add a generic checkout or CI watcher protocol.

Pins are local native UI state, not a remote mutation capability. Store mod-source pins
atomically in `pull-request-pins.json` beside the mod registry under the server's mods state
directory, keyed by full origin and item identity. Keep pins through disable and reload;
remove that mod's pins when it is deleted. Existing GitHub project pins keep their storage
and behavior. The mod-source pin file remains inert on Stable.

## Lifecycle, sign-in, and errors

Only enabled, trusted, running mods can register active sources. Stop, disable, crash, file
trust invalidation, unregister, and reload withdraw registrations and invalidate their
queries. Preserve a selected source-aware link so an unavailable detail can explain what
happened and link to Mods settings; it must not select a similarly named GitHub item.

Each request belongs to a mod generation. Results from an older generation are discarded.
Stopping a mod requests cancellation through the existing worker and MCP teardown; it does
not claim that a remote write already sent to a service was undone.

Catch source failures independently. One failed source must not hide healthy GitHub or
other mod rows. Code review can show the last good read with a stale-data warning while
that same running source refreshes; disabling or withdrawing the source removes its rows
and prevents further actions. Invalid data fails with a useful field error in the mod log
and a source-specific notice, rather than crashing the page.

MCP sign-in continues using the existing per-mod, per-server mechanism. A source request
that needs authentication shows the existing Sign in flow within Code review. The mod does
not receive credentials. Sign-in completion invalidates the affected mod's visible source
queries; sign-out drops their sensitive cached reads. Multiple source identities do not
create a shared token store or introduce dependency on an AI provider CLI.

The existing mods Beta gate applies to registration, request dispatch, snapshot metadata,
navigation controls, and persisted origin-aware references. Stable refuses mod-source
operations and keeps its built-in GitHub behavior.

## Authoring and migration

Update these shipped resources together with the implementation:

- `apps/server/src/mods/skill/SKILL.md`: when to use a native PR source, registration and hooks,
  normalization, capabilities, pagination, invalidation, sign-in, and debugging.
- `apps/server/src/mods/skill/types/synara.d.ts`: the complete typed API and event results.
- `apps/server/src/mods/skill/examples/`: a working generic native-source example with fixture
  data and a documented MCP-backed variant using illustrative tool names.
- `docs/mods.md`: the native Code review extension and its lifecycle and limits.

Retain sidebar and dock support for mods whose purpose fits those locations. The guide must
distinguish a custom view from a native PR data source and direct authors wanting the existing
review workflow to the latter.

Migration of Nacho's mod uses the published API: keep its MCP and OAuth configuration,
register a source, move its reads into the typed hooks, normalize the actual MCP payloads,
advertise only implemented operations, and remove its redundant sidebar registration. The
actual company MCP mapping is performed on Nacho's other computer, where that mod and the
service are available. Synara's implementation and fixtures do not require company access.

## Verification and acceptance

The implementation is accepted when:

1. A generic fixture mod supplies PRs to the native Code review list and detail without
   registering a sidebar or dock view.
2. A second independent source with overlapping repository and item IDs coexists without
   cross-source selection, cache, pin, viewer, or mutation collisions.
3. List, pagination, detail, diff, comment, and supported actions route to the owning mod;
   unsupported operations are rejected by the host before hook execution.
4. Generic opaque identifiers and service URLs work without GitHub parsing, including items
   without local project associations.
5. No backing-service call occurs during source discovery or from hidden mod-source pages;
   explicit refresh and invalidation update the visible native views.
6. Mod errors and sign-in requests stay isolated, and stale reads and mutation acknowledgements
   follow the behavior specified above.
7. Disable, trust changes, crash, unregister, reload, and sign-out do not leave callable stale
   sources or apply results from an earlier mod generation.
8. Existing GitHub list, issue, detail, action, pin, deep-link, and agent workflows keep passing,
   and Stable refuses mod-source operations.
9. The shipped skill's examples typecheck and load in the worker. An author can discover and
   implement the API from the shipped references without reading host internals.

During implementation run focused contracts, host, cache/selection, and browser interaction
tests. Group the final format, lint, typecheck, full cross-package test suite, relevant browser
tests, and compiled-worker smoke check into one verification pass. Use native components and
existing fixture tools for before/after screenshots. Add Windows boundary checks only if
process code changes, and migration checks only if a database migration becomes necessary.

Publish the implementation to the existing branch in Nacho's fork without opening a PR,
matching the current shipping decision. Report local fixture evidence separately from the
later live company MCP verification.
