---
name: synara-mods
description: Use when building, changing, debugging or explaining Synara mods or plugins, supplying pull requests to native Code review, adding custom views or commands, or enabling, importing and exporting mods.
---

# Synara mods

A mod is a folder in the mods folder. Synara runs each enabled mod in its own
worker and reloads it whenever its files change. A mod reaches Synara only
through the `$` object its hooks receive, and draws its views as JSX trees that
Synara renders with its own components.

- Mods folder: `{{MODS_DIR}}`
- This skill's files: `{{SKILL_DIR}}`

## What to tell the person about mods

When the person asks about mods rather than for one, answer from this:

- **What it is.** A folder of TypeScript that adds to Synara's interface: a
  sidebar view, a dock panel, a band above the composer, buttons in the thread
  header, native Code review sources, palette commands, notices and a status line. It can read the thread
  and project lists and call MCP servers its manifest declares.
- **Agents.** A mod can watch when turns and tools start and end. With a
  permission the enable dialog names, it can also change the messages the
  person sends to agents, deny tool calls waiting for approval, and give agents
  new tools.
- **Beta only.** Mods exist only in Synara Beta; a Stable build ignores them.
- **Where it runs.** On the computer that runs Synara's server, each mod in its
  own worker. Windows connected from elsewhere only draw its views.
- **Trust.** A mod is not sandboxed: it runs with Synara's own access. A new
  mod starts off; the person turns it on in **Settings → Mods**, which asks them
  to confirm they trust it. That trust is in the mod's files as they were: when
  they change, the mod stops, shows **Changed**, and waits for **Trust
  changes**, unless the person ticked **Keep reloading it when its files
  change** for a mod being written. The same page shows each mod's state, log,
  commands, views and registered PR sources, and reloads it.
- **Sharing.** **Export** next to a mod in Settings → Mods saves one
  `<name>.synara-mod.json` file; **Import…** on the same page, or dropping
  the file onto it, installs one, turned off. Hidden files such as `.env`, `node_modules`, what the mod saved
  with `$.store` and its on or off state stay behind. Importing a mod that is
  already installed asks to replace it, turns it off, and keeps its saved data.

## A mod in three files

```
{{MODS_DIR}}/<name>/
  .synara-mod/mod.json   {"name": "<name>", "version": "0.1.0", "description": "<one line>"}
  hooks/hooks.json       {"modules": ["./register.tsx"]}
  hooks/register.tsx     export const register: Register = (on) => { … }
```

- `<name>` is lowercase words joined by dashes and must equal the folder name.
- `register.tsx` may import its own files (`./data`) and `"synara"`, nothing
  else: no npm packages and no `node:` modules. Everything outside the mod goes
  through `$`.
- Write TypeScript and JSX directly; Synara compiles them when it loads the mod.

## Hooks

`on(event, matcher?, hook)` adds a hook. Every hook is `($, e, next)`:

- `$` is the interface to Synara.
- `e` is the event's input, a frozen plain value.
- `next(e)` runs the rest of the chain.

The matcher compares fields of `e`, so `on("command.run", { command: "x" }, …)`
only runs for that command.

| Event         | `e`                                                | Return                                     |
| ------------- | -------------------------------------------------- | ------------------------------------------ |
| `mod.start`   | `{}`                                               | nothing. Register views and commands here. |
| `mod.stop`    | `{}`                                               | nothing. Runs before a reload or disable.  |
| `ui.render`   | `{ view, site, context: { threadId, projectId } }` | a JSX tree, or `null` to draw nothing      |
| `command.run` | `{ command, threadId }`                            | `{ text }` to show a toast, or nothing     |

Native PR hooks are in [Native Code review](#native-code-review); agent events
are in [Agents](#agents).

A hook has 10 seconds to finish, not counting time spent in `next`. A hook
that throws is skipped and its error goes to the mod's log. A hook that blocks
its worker with synchronous code for 10 seconds stops the mod.
Native PR request hooks propagate errors to their source's native UI instead
of falling through to another mod.

## The `$` object

| Call                                                                                      | What it does                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$.ui.view({ id, site, title, icon?, refreshOn? })`                                       | Adds a view. `site` is `"sidebar"`, `"dock"`, `"band"` or `"header"`. `refreshOn: ["threads"]` redraws it when threads change.                                                                                                                                  |
| `$.ui.invalidate(viewId?)`                                                                | Draws a view again (all of the mod's views without an id).                                                                                                                                                                                                      |
| `$.ui.toast(text, { tone })`, `$.ui.status(text)`                                         | A notice in every window; a status line in Settings → Mods.                                                                                                                                                                                                     |
| `$.ui.openThread(id)`, `$.ui.openUrl(url)`, `$.ui.openDockView(viewId)`                   | Only inside a handler such as `onPress`. They act on the window that pressed.                                                                                                                                                                                   |
| `$.tool.register({ name, description, inputSchema? })`                                    | Gives agents a tool (needs the `tools` permission). Answer it with a `tool.call` hook. See Agents.                                                                                                                                                              |
| `$.command.register({ name, title, description? })`                                       | Adds a command to the palette (⌘K). Answer it with a `command.run` hook.                                                                                                                                                                                        |
| `$.pullRequests.registerSource({ id, title, capabilities? })`                             | Publishes a source in native Code review. Register metadata in `mod.start`; answer list/detail hooks on demand.                                                                                                                                                 |
| `$.pullRequests.unregisterSource(id)`, `$.pullRequests.invalidate(id?)`                   | Removes a source; or refreshes its active native queries (all owned sources when omitted).                                                                                                                                                                      |
| `$.threads.list({ projectId?, includeArchived?, limit? })`, `$.threads.get(id)`           | Threads, newest first. Fields: `id`, `projectId`, `title`, `provider`, `model`, `branch`, `worktreePath`, `parentThreadId`, `isPinned`, `latestTurnState`, `hasPendingApprovals`, `hasPendingUserInput`, `createdAt`, `updatedAt`, `archivedAt`. No transcript. |
| `$.projects.list()`                                                                       | Projects: `id`, `title`, `workspaceRoot`, `kind`, `isPinned`, `createdAt`, `updatedAt`. `kind === "project"` are the folders in the sidebar.                                                                                                                    |
| `$.mcp.tools(server)`, `$.mcp.call(server, tool, args)`, `$.mcp.json(server, tool, args)` | Calls an MCP server the manifest declares (see below). `json` returns the structured result or the text parsed as JSON.                                                                                                                                         |
| `$.mcp.status(server)`                                                                    | `"sign-in-needed"` while the server waits for the person to sign in, otherwise `"ready"`. It does not call the server.                                                                                                                                          |
| `$.state.get/set(key, value)`                                                             | Values held while Synara runs; they survive reloads. `set` redraws the mod's views.                                                                                                                                                                             |
| `$.store.get/set/delete/keys`                                                             | JSON saved to disk, 1 MB per mod.                                                                                                                                                                                                                               |
| `$.log(msg)`, `$.log.warn/error`, `console.log`                                           | The mod's log in Settings → Mods.                                                                                                                                                                                                                               |

Every call returns a promise. `types/synara.d.ts` has the exact signatures.

## Native Code review

When PRs should appear in Synara's existing **Code review**, register a native
source with `$.pullRequests.registerSource`. Use `$.ui.view` for a custom
sidebar or dock interface. A native source needs no `ui.render`, rail button
or custom tab. The host supplies the list, summary, diff, timeline, pinning,
comment composer and supported action controls.

Start from `examples/native-pr-source/`: a working fixture source called
`team-reviews`, with pagination, detail, diff, comments and close/reopen hooks.
It registers no views and requires no accounts. Copy the folder under the
same name, or rename both its folder and manifest `name`.

```ts
import type { Register } from "synara";

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    await $.pullRequests.registerSource({
      id: "team-reviews",
      title: "Team reviews",
      capabilities: { diff: true, comment: true, actions: ["close", "reopen"] },
    });
  });
  // Add list/detail and every advertised optional hook as in the example.
};
```

Hooks are matched with `{ sourceId: "team-reviews" }` and dispatched only to
the owning mod. `types/synara.d.ts` defines the complete inputs and results:

| Hook                   | Input after `sourceId`                                                                         | Result                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pullRequests.list`    | `state: "open" \| "closed"`, `sort: "created" \| "updated"`, `cursor: string \| null`, `limit` | `{ items, nextCursor?, totalCount?, viewer? }`                |
| `pullRequests.detail`  | `repository`, `itemId`, `forceRefresh: boolean`                                                | `ModPullRequestDetail`                                        |
| `pullRequests.diff`    | `repository`, `itemId`                                                                         | `{ patch, truncated }`                                        |
| `pullRequests.comment` | `repository`, `itemId`, `body`                                                                 | `{ ok: true }` after acknowledgement                          |
| `pullRequests.action`  | `repository`, `itemId`, `action`, optional `mergeMethod`                                       | `{ ok: true, mergeOutcome?: "merged" \| "enqueued" \| null }` |

- **Required:** list and detail. Minimum item: `repository`, `itemId`, `title`,
  HTTP(S) `url`, `state` (`open`, `closed`, `merged`). Detail must return the
  requested identity. `closed` listings include closed and merged PRs.
- **Identity:** `(modId, sourceId, repository, itemId)`. Repository and item
  IDs are opaque, case-sensitive strings: preserve them unchanged. `url` is a
  display link; it never chooses the service. `displayNumber` is optional.
- **Capabilities:** `diff`, `timeline`, `comment` default false; `actions`
  and `mergeMethods` default empty. Advertise only implemented operations.
  Actions are `merge`, `ready`, `draft`, `close`, `reopen`; methods are `merge`,
  `squash`, `rebase`. A detail's `mergeMethods` further restricts source
  methods; omission allows none. State and draft metadata restrict controls
  too. The backing service must authorize and validate every write.
- **Unknown data:** omit it or use `null`: dates, authors, counts, body,
  branches, labels, checks, reviewers, comments and commits. Use empty arrays
  only when the service confirms there are none. Synara shows unavailable
  metadata without inventing GitHub fields. A timeline uses the detail's
  comments and commits; there is no separate timeline hook.
- **Paging:** respect `limit` (at most 500), requested state and sort. Forward
  an upstream cursor unchanged; return `nextCursor: null` when finished.
  `viewer` belongs to this source. Don't substitute another source's login.
- **Projects:** optional `projectIds` may name existing Synara projects.
  Discover them with `$.projects.list()` and associate only genuine matches.
  Synara resolves paths and titles; the mod must not invent a workspace path.
- **Demand and refresh:** `mod.start` only registers metadata. Reads begin
  when Code review is open, detail when selected, diff when **Changes** is
  opened. No background PR polling is added. Explicit refresh and
  `$.pullRequests.invalidate(sourceId?)` refresh active queries; inactive
  views stay idle. `$.ui.invalidate` is for custom views, not native sources.
  `forceRefresh` lets detail adapters bypass their own cache when requested.
- **Lifecycle/errors:** disabling, unregistering, reloading or losing trust
  withdraws the source and its stale results. Throw source errors; other
  sources remain usable. Let `mcp_sign_in_needed` propagate: Code review
  shows the owning mod's **Sign in** button. Signing in refreshes its reads;
  signing out clears its cached data. Never turn a failed read into an empty
  successful list.
- **Writes:** return `ok: true` only after the service acknowledges the write.
  Synara sends once, without automatic retries. A later refresh failure is
  reported separately. On an uncertain write outcome, check the service
  before retrying. Call `invalidate` when the mod learns data changed.
- **Agents:** **Ask** and **Send to agent** attach a reference with the full
  source identity. A mod PR does not run GitHub checkout/branch preparation.
  Cards remain readable when the source is unavailable.

### Adapting an MCP service

Keep service-specific tool names, arguments and mapping inside the mod. First
inspect `await $.mcp.tools("reviews")` in a command or request hook to learn
the real schemas. Registration alone must not call the service. This
illustrative list adapter assumes tool `list_reviews` and the exact payload
below; replace them with the discovered schema and validate external data:

```ts
import type { Register } from "synara";
type RemotePage = {
  reviews: Array<{
    repo: string;
    key: string;
    subject: string;
    link: string;
    state: "open" | "closed" | "merged";
  }>;
  cursor: string | null;
};

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    await $.pullRequests.registerSource({ id: "team-reviews", title: "Team reviews" });
  });
  on("pullRequests.list", { sourceId: "team-reviews" }, async ($, e) => {
    const page = await $.mcp.json<RemotePage>("reviews", "list_reviews", {
      state: e.state,
      sort: e.sort,
      cursor: e.cursor,
      limit: e.limit,
    });
    return {
      items: page.reviews.map((r) => ({
        repository: r.repo,
        itemId: r.key,
        title: r.subject,
        url: r.link,
        state: r.state,
      })),
      nextCursor: page.cursor,
    };
  });
  // Required: add pullRequests.detail using the service's real tool/schema.
};
```

The host validates the normalized result. Map service states, dates, nested
comments, checks and diff results to the published types. Do not advertise
diff, timeline, comments or actions until the adapter supplies their data or
hooks. Return an acknowledged mutation rather than fabricating success.

### Migrating an existing PR mod

Keep its `name`, `mcpServers`, environment placeholders and OAuth configuration
unchanged. Replace its redundant PR sidebar/dock registration with a native
source in `mod.start`; move reads from `ui.render` into list/detail/diff hooks.
Keep unrelated views and commands. Preserve upstream identifiers and cursors,
map only known metadata, and declare the capabilities its service supports.
After edits, reload and accept **Trust changes** in Settings → Mods when
required. Open Code review, select the source, exercise summary/Changes and
inspect its log. Test writes only when the person explicitly requests them.

## Agents

A mod can watch what agents do and, with a permission the person sees before
enabling it, act on it. Permissions go in `mod.json`:

```json
{ "name": "team-rules", "version": "0.1.0", "permissions": ["prompts", "approvals", "tools"] }
```

| Event                | Permission  | `e`                                                                | Return                                                         |
| -------------------- | ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| `thread.created`     | none        | `{ threadId, projectId, title }`                                   | nothing                                                        |
| `turn.started`       | none        | `{ threadId, origin }` (`user`, `automation` or `agent`)           | nothing                                                        |
| `turn.completed`     | none        | `{ threadId, turnId, state }`                                      | nothing                                                        |
| `tool.started`       | none        | `{ threadId, turnId, tool, kind, status }`                         | nothing                                                        |
| `tool.completed`     | none        | the same                                                           | nothing                                                        |
| `prompt.submit`      | `prompts`   | `{ threadId, projectId, provider, model, text }`                   | `{ text }` to send that instead, `{ block: "why" }` to stop it |
| `approval.requested` | `approvals` | `{ threadId, requestId, provider, kind, toolName, title, detail }` | `{ deny: "why" }` to decline it for the person                 |
| `tool.call`          | `tools`     | `{ tool, arguments, threadId }`                                    | the tool's result: text or JSON                                |

- **Watching** events say when things happen, never what was written or run.
  They run beside the agent and cannot slow it; a mod busy with eight of them
  misses the next.
- **`prompt.submit`** sees what the person wrote, before Synara adds context.
  The thread keeps the person's message and notes "Message changed by the X
  mod". Answer within 10 seconds or the message goes as written. Messages from
  agents and automations do not pass through it.
- **`approval.requested`** can only deny. It never runs in full access, where
  nothing waits for approval, nor with Pi or Antigravity. The person may answer
  first. `detail` is what the approval card shows; a provider may shorten a long
  command, so do not rely on it to catch text far into one.
- **Tools.** `$.tool.register({ name, description, inputSchema })` in
  `mod.start` gives agents a tool, served as `mod_<mod>_<name>`; answer it with
  `on("tool.call", { tool: "<name>" }, …)`. Up to 10 tools. A session that reads
  its tool list only when it starts sees the tools registered by then, so ask
  the person to start a new chat after adding one. Agents read the description
  as an instruction: say plainly what the tool does.
- A hook for one of the last three without its permission never runs; the mod's
  log says which permission to add.

The `agent-hooks` example uses all of them.

## MCP servers

A mod reaches outside services through MCP servers declared in its manifest:

```json
{
  "name": "pr-panel",
  "version": "0.1.0",
  "mcpServers": {
    "bitbucket": {
      "command": "npx",
      "args": ["-y", "some-bitbucket-mcp-server"],
      "env": { "BITBUCKET_TOKEN": "${env:BITBUCKET_TOKEN}" }
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:REMOTE_TOKEN}" }
    }
  }
}
```

- `${env:NAME}` takes the value from Synara's environment, so tokens stay out of
  the mod's files. Never write a token into a mod. A local server gets ordinary
  variables plus its `env`, never Synara's own `SYNARA_*` variables or provider
  credentials, and `${env:SYNARA_*}` is always empty.
- Call `$.mcp.tools("bitbucket")` first to learn the tool names and arguments
  (for example from a command that logs them) before using them.
- Many servers answer with JSON as text; `$.mcp.json` parses it for you.
- Waiting on an MCP call does not count toward a hook's 10 seconds. A call
  itself gives up after 30 seconds.
- Changing `mcpServers` restarts the mod and its servers.

### A server that asks the person to sign in

Some remote servers want the person's own account (OAuth) instead of a token in
a header. The mod writes nothing for it. Synara notices when the server refuses
a call, shows the person a **Sign in** button in the mod's view and on its row
in Settings → Mods, keeps the token itself and sends it with every call.

- **Neither the mod nor you can sign in.** Only the person can, with that
  button. `synara_mods_list` lists these servers under `mcpSignIns` as `needed`
  or `signed-in`. While one is `needed`, say so and ask the person to press
  Sign in; it is not a bug in the mod, and there is nothing to work around.
- **Until they sign in,** every `$.mcp` call to that server rejects with an
  error whose `code` is `"mcp_sign_in_needed"`. Let it escape from `ui.render`:
  Synara then draws its sign-in card in place of the view. Catch it only to
  draw the rest of a view; Synara shows the button above what you drew.
- **After the sign-in** Synara draws the mod's views and refreshes active native
  PR reads. Load data in a render, handler or native PR request, not once in `mod.start`: a `mod.start` that
  ran before the sign-in does not run again.
- **Declare it when you know it,** so the person is told before the first call:

  ```json
  "remote": { "url": "https://example.com/mcp", "oauth": {} }
  ```

- **`clientId`.** Most servers register Synara as an app by themselves. One
  that does not makes the sign-in fail with a message that says so, on the
  mod's row and in its log. Its manifest must then name a client id that was
  registered with that server for the return address
  `http://127.0.0.1:47823/callback`:

  ```json
  "oauth": { "clientId": "https://example.com/synara-client.json", "scopes": ["read"] }
  ```

  Ask the person for the client id. Never invent one or borrow another app's.
  `scopes` defaults to the ones the server lists; `callbackPort` is for a
  client id registered with another port.

  When the message says the server accepts a client metadata document, the
  client id is the `https` address of a JSON file the person publishes. Give
  them this to publish, with its own address as `client_id`:

  ```json
  {
    "client_id": "https://example.com/synara-client.json",
    "client_name": "Synara mods",
    "redirect_uris": ["http://127.0.0.1:47823/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none"
  }
  ```

- A sign-in belongs to this mod and this server address: changing `url` ends
  it, and another mod using the same server asks the person again. Do not also
  put `Authorization` in `headers`.
- The server must be `https` (or run on this computer).

## Views

Return JSX built from the elements `"synara"` exports (they are also globals,
so the import is optional). Synara draws them with
its own components and the text size the person chose, so a mod always looks
native. Props take fixed values, not CSS or class names.

| Element                                                | Props                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `Box`                                                  | `direction`, `gap`, `padding`, `paddingX`, `paddingY` (0, 1, 2, 3, 4, 6), `align`, `justify`, `grow`, `wrap`, `border`, `scroll` |
| `Text`                                                 | `size` (`xs`, `sm`, `md`, `lg`), `tone` (`muted`, `success`, `warning`, `danger`, `info`), `weight`, `mono`, `truncate`, `block` |
| `Heading`, `Section`                                   | `Section title` groups rows the way "Projects" does in the sidebar                                                               |
| `List`, `Row`                                          | `Row`: `title` (its text), `icon`, `meta`, `active`, `onPress`; children follow the title (a badge). It is a sidebar row.        |
| `Button`                                               | `icon`, `label`, `variant` (`outline`, `ghost`, `default`, `secondary`, `destructive`), `disabled`, `onPress`                    |
| `Input`                                                | `placeholder`, `defaultValue`, `onSubmit(value)` (Enter), `onChange(value)` (after a pause)                                      |
| `Switch`                                               | `checked`, `label`, `onChange(checked)`                                                                                          |
| `Markdown`, `Code`                                     | `text`, or the text as children                                                                                                  |
| `Icon`, `Badge`, `Link`, `Divider`, `Spinner`, `Empty` | see `types/synara.d.ts`                                                                                                          |

- **Handlers.** `onPress`, `onChange` and `onSubmit` run in the mod. Keep them
  short; redraw by changing `$.state` or calling `$.ui.invalidate`. A button is
  disabled while its handler runs, and an `Input` clears after `onSubmit`.
- **Rendering.** `ui.render` only reads and returns a tree. `$.state.set` and
  `$.ui.invalidate` called while a view draws do not redraw it, so load data
  in a handler or command, or cache it in `$.state` on first draw.
- **Errors.** A render or command that throws shows its error in the window
  and in the log, so let errors surface instead of returning nothing.
- **Icons.** Icons are Central icon names. A name that does not exist is
  dropped (a view falls back to the mod glyph) and the log says so, so check it
  first with `grep -x <name> {{SKILL_DIR}}/reference/icons.txt`, or search with
  `grep <word> …/icons.txt`. Common names: `star`, `bell`, `clock`, `code`,
  `folder-2`, `pull-request`, `branch`, `chat-bubble-7`, `layout-dashboard`.
- **Sites.** Each site has its own space:
  - `sidebar` views get a rail button and replace the thread list.
  - `dock` views open as a tab next to the thread, from the dock's + menu or `$.ui.openDockView`.
  - `band` views sit above the composer of the open thread.
  - `header` views sit in the thread header. Keep them to one or two buttons; the header hides them on an empty thread.
- **Size limit.** A tree may hold up to 5,000 elements. Draw what is in view,
  not every item you have.

## Loading and checking a mod

1. Write the three files. Start from an example in `{{SKILL_DIR}}/examples/`:
   - `hello-command`: a command and the store
   - `threads-by-day`: a sidebar view
   - `thread-notes`: a band with an input
   - `pr-panel`: a header button and a dock view
   - `native-pr-source`: data in native Code review, no custom view
   - `agent-hooks`: prompt rules, denied approvals, a tool for agents
2. A new mod starts disabled. Only the person can enable it, in
   **Settings → Mods**, because a mod runs with Synara's own access. Ask them to
   switch it on and to tick **Keep reloading it when its files change** in that
   dialog: then every save reloads it until Synara restarts. Without that, your
   next edit stops the mod with status `changed`, and only the person can start
   it again with **Trust changes**; reloading does not. A disabled mod has not
   run yet, so `synara_mods_list` cannot show its load errors until it is on:
   do not report it as working before that.
3. Check it with Synara's tools:
   - `synara_mods_list`: status, load error, views, commands and PR sources.
   - `synara_mod_logs`: its log and console output.
   - `synara_mod_render`: draw a view as a JSON tree without opening the window.
   - `synara_mod_reload`: reload it.

   A load error names the file and the line. Once the mod is on, draw every
   custom view with `synara_mod_render` and read the log. For a native source,
   open Code review and validate list, selected detail and advertised operations;
   `synara_mod_render` does not test native PR hooks. A registered source alone
   proves neither authentication nor its data mapping works.

4. Optional type check:
   1. Copy `{{SKILL_DIR}}/reference/tsconfig.json` into the mod folder. Its `paths` already point at this skill's types.
   2. Run `npx -y -p typescript tsc -p <mod folder>`.

## Rules

- Every effect goes through `$`.
- Do not read files, start processes or call the network from a mod. The mod
  interface has no way to do it, and imports outside the mod are refused.
- Limits: `$.state` 4 MB and 1,000 keys, `$.store` 1 MB, 5 toasts and 200 log
  lines every 10 s, 20 views and 50 commands. A hook may run for 10 s of its own
  time and 60 s in all, waits included.
- Keep data a view needs in `$.state` (fast, lost on restart) or `$.store`
  (saved), never in module variables. A reload starts the module over.
- Mods are a Beta feature. On a Stable build the mods folder is ignored.
