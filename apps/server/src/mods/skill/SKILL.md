---
name: synara-mods
description: Write, load, debug and explain Synara mods, small TypeScript modules that customize Synara itself with sidebar views, dock panels, bands above the composer, thread header buttons and palette commands. Use when the person asks to build, change or fix a Synara mod or plugin, to add something to Synara's interface, or to show their own data (pull requests, tickets, notes) inside Synara; and when they ask what mods are, where they run, or how to enable, share, export or import one.
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
  header, palette commands, notices and a status line. It can read the thread
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
  commands and views, and reloads it.
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

The agent events are in [Agents](#agents) below.

A hook has 10 seconds to finish, not counting time spent in `next`. A hook
that throws is skipped and its error goes to the mod's log. A hook that blocks
its worker with synchronous code for 10 seconds stops the mod.

## The `$` object

| Call                                                                                      | What it does                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$.ui.view({ id, site, title, icon?, refreshOn? })`                                       | Adds a view. `site` is `"sidebar"`, `"dock"`, `"band"` or `"header"`. `refreshOn: ["threads"]` redraws it when threads change.                                                                                                                                  |
| `$.ui.invalidate(viewId?)`                                                                | Draws a view again (all of the mod's views without an id).                                                                                                                                                                                                      |
| `$.ui.toast(text, { tone })`, `$.ui.status(text)`                                         | A notice in every window; a status line in Settings → Mods.                                                                                                                                                                                                     |
| `$.ui.openThread(id)`, `$.ui.openUrl(url)`, `$.ui.openDockView(viewId)`                   | Only inside a handler such as `onPress`. They act on the window that pressed.                                                                                                                                                                                   |
| `$.tool.register({ name, description, inputSchema? })`                                    | Gives agents a tool (needs the `tools` permission). Answer it with a `tool.call` hook. See Agents.                                                                                                                                                              |
| `$.command.register({ name, title, description? })`                                       | Adds a command to the palette (⌘K). Answer it with a `command.run` hook.                                                                                                                                                                                        |
| `$.threads.list({ projectId?, includeArchived?, limit? })`, `$.threads.get(id)`           | Threads, newest first. Fields: `id`, `projectId`, `title`, `provider`, `model`, `branch`, `worktreePath`, `parentThreadId`, `isPinned`, `latestTurnState`, `hasPendingApprovals`, `hasPendingUserInput`, `createdAt`, `updatedAt`, `archivedAt`. No transcript. |
| `$.projects.list()`                                                                       | Projects: `id`, `title`, `workspaceRoot`, `kind`, `isPinned`, `createdAt`, `updatedAt`. `kind === "project"` are the folders in the sidebar.                                                                                                                    |
| `$.mcp.tools(server)`, `$.mcp.call(server, tool, args)`, `$.mcp.json(server, tool, args)` | Calls an MCP server the manifest declares (see below). `json` returns the structured result or the text parsed as JSON.                                                                                                                                         |
| `$.mcp.status(server)`                                                                    | `"sign-in-needed"` while the server waits for the person to sign in, otherwise `"ready"`. It does not call the server.                                                                                                                                          |
| `$.state.get/set(key, value)`                                                             | Values held while Synara runs; they survive reloads. `set` redraws the mod's views.                                                                                                                                                                             |
| `$.store.get/set/delete/keys`                                                             | JSON saved to disk, 1 MB per mod.                                                                                                                                                                                                                               |
| `$.log(msg)`, `$.log.warn/error`, `console.log`                                           | The mod's log in Settings → Mods.                                                                                                                                                                                                                               |

Every call returns a promise. `types/synara.d.ts` has the exact signatures.

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
- **After the sign-in** Synara draws the mod's views again. Load the data when
  the view draws or in a handler, not once in `mod.start`: a `mod.start` that
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
   - `synara_mods_list`: status, load error, views and commands.
   - `synara_mod_logs`: its log and console output.
   - `synara_mod_render`: draw a view as a JSON tree without opening the window.
   - `synara_mod_reload`: reload it.

   A load error names the file and the line. Once the mod is on, draw every view
   with `synara_mod_render` and read the log before saying it works.

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
