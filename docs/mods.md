# Mods

A mod is a small TypeScript module that changes Synara itself. It can add a view to the
sidebar, a panel to the dock, a band above the composer, buttons to the thread header, and
commands to the palette, and it can show notices and a status line. Mods have the same shape as
Claude Code's mods: a folder with a module that registers hooks.

> **Synara Beta only.** Mods ship in Synara Beta. Stable ignores the mods folder, refuses the
> mods APIs, and hides **Settings → Mods**.

> **Mods are not sandboxed.** An enabled mod runs with Synara's own access on the computer that
> runs Synara's server: it can read your thread and project lists and call the services its
> manifest declares. Only enable mods you wrote or trust.

## Get a mod

- **Ask an agent.** Type `$synara-mods` in the composer and describe what you want. The skill
  teaches the agent the mod format, and Synara's mod tools (`synara_mods_list`,
  `synara_mod_logs`, `synara_mod_render`, `synara_mod_reload`) let it load, draw and debug the
  mod. You still turn the mod on yourself.
- **Import one.** See [Share a mod](#share-a-mod).
- **Write one by hand.** See [Write a mod](#write-a-mod).

## Turn a mod on

Open **Settings → Mods**. The page shows the mods folder, how many mods are running, and one
row per mod with its state (**Off**, **Starting**, **Running** or **Error**), description,
version, the commands and views it registered, and any load error.

A new mod starts **Off**. Turn on its switch and confirm **Enable the "<name>" mod?** to run it.
Each row also has **Reload**, **Export**, and a **Log** with what the mod wrote and why it
failed.

Enabling a mod trusts its files as they are at that moment. If they change afterwards, Synara
stops the mod, marks it **Changed**, and waits for you to press **Trust changes**: new code does
not run on the old code's trust, whether you, an agent or anything else wrote it. While you or
an agent you are watching is writing a mod, tick **Keep reloading it when its files change** in
that dialog; the mod then reloads on every save until Synara restarts or you turn it off.

## What a mod can add

| Where              | What it looks like                                                         |
| ------------------ | -------------------------------------------------------------------------- |
| `sidebar` view     | A button in the sidebar rail; its view replaces the thread list while open |
| `dock` view        | A tab next to the thread, opened from the dock's **+** menu                |
| `band` view        | A strip above the composer of the open thread                              |
| `header` view      | One or two buttons in the thread header                                    |
| Commands           | Entries in the command palette (⌘K)                                        |
| Notices and status | Toasts in every window, and a status line in Settings → Mods               |

A mod can also work with agents; see [Mods and agents](#mods-and-agents).

Views are drawn with Synara's own components and text size, so a mod looks native. A mod reads
data through `$`: the thread and project lists (no transcripts), values it keeps while Synara
runs (`$.state`), JSON it saves to disk (`$.store`, 1 MB per mod), and MCP servers its manifest
declares (`$.mcp`).

## Write a mod

A mod is a folder in the mods folder with three files:

```
<mods folder>/hello-command/
  .synara-mod/mod.json
  hooks/hooks.json
  hooks/register.tsx
```

`.synara-mod/mod.json` names the mod. The name must match the folder name:

```json
{
  "name": "hello-command",
  "version": "0.1.0",
  "description": "A palette command that counts your threads and shows a toast."
}
```

`hooks/hooks.json` points at the module: `{ "modules": ["./register.tsx"] }`.

`hooks/register.tsx` registers hooks. Every hook receives `$`, the mod's only way to reach
Synara:

```tsx
import type { Register } from "synara";

export const register: Register = (on) => {
  on("mod.start", async ($) => {
    await $.command.register({ name: "count-threads", title: "Count my threads" });
  });

  on("command.run", { command: "count-threads" }, async ($) => {
    const threads = await $.threads.list({ includeArchived: true, limit: 1000 });
    // The returned text becomes a toast in the window that ran the command.
    return { text: `${threads.length} threads.` };
  });
};
```

- Write TypeScript and JSX directly; Synara compiles the mod when it loads it.
- A mod may import its own files and `"synara"`, nothing else: no npm packages and no `node:`
  modules.
- A hook has 10 seconds to finish. A hook that fails is skipped and its error goes to the log.
- To reach an outside service, declare an MCP server in `mod.json` under `mcpServers` and call
  it with `$.mcp`. Write tokens as `${env:NAME}` so they stay out of the mod's files. A local
  MCP server gets ordinary environment variables plus the `env` its manifest lists, not
  Synara's own `SYNARA_*` variables or provider credentials; `${env:SYNARA_*}` is always empty.
  A service that wants your own account signs you in instead; see
  [Sign in to a mod's server](#sign-in-to-a-mods-server).

The complete reference, with every event, `$` call, view element and four examples, is the
`synara-mods` skill in [`apps/server/src/mods/skill/`](../apps/server/src/mods/skill/). Synara
installs it under `builtin-skills/synara-mods` in its home folder.

## Sign in to a mod's server

A mod can use an outside service that wants your own account, such as your company's pull
requests. Synara does that sign-in itself; the mod never sees your password or your token.

- When the service asks, the mod's view shows **Sign in**, and so does the mod's row in
  Settings → Mods. The button opens the service's own sign-in page in your browser. When you
  finish there, the view fills in.
- **Each sign-in belongs to one mod and one server address.** Another mod that uses the same
  service asks you again. The button names the server's host: that is where your token goes,
  so check it is the service you expect.
- Synara keeps the token with its own secrets on the computer that runs it and sends it only
  to that address. It renews the token when the service allows; otherwise it asks you to sign
  in again when the token runs out.
- **Sign out** on the mod's row forgets it. Deleting the mod, or replacing it with an imported
  file, does too. Turning the mod off, or trusting an edit to it, keeps it. Signing out removes
  the token from Synara; it does not cancel it at the service.
- Sign in on the computer that runs Synara: your browser returns to an address on that
  computer (`http://127.0.0.1:47823/callback`). Only the owner's own session can sign in; a
  paired device can sign out.

A mod's author writes nothing for this. A service that does not register apps by itself needs
a `clientId` in the mod's `mod.json`; the `synara-mods` skill explains it.

## Mods and agents

A mod can watch agent activity: when a thread is created, when a turn starts or ends, and when
a tool starts or finishes. It learns when things happen, not what was written or run.

To act on agents, a mod asks for permissions in `mod.json`. The dialog that enables the mod
names each one, and the mod's row in Settings → Mods keeps showing them:

| Permission  | What the mod may do                                                          |
| ----------- | ---------------------------------------------------------------------------- |
| `prompts`   | Change a message you send to an agent, or stop it and tell you why           |
| `approvals` | Deny a tool call that is waiting for your approval. It can never approve one |
| `tools`     | Give agents new tools, served as `mod_<mod>_<tool>`                          |

- **Changed prompts.** The thread keeps your message as you wrote it and adds a line such as
  "Message changed by the team-rules mod". Messages that agents and automations send do not
  pass through mods. A mod that fails or takes longer than 10 seconds is skipped.
- **Denied approvals.** The thread shows the request as declined, with "Denied by the X mod" and
  its reason. If you answer before the mod does, your answer stands. Nothing is denied in full
  access, where agents do not ask, nor with Pi or Antigravity, which do not ask through Synara.
- **Tools.** Agents read a tool's description as an instruction, so only enable a mod with
  `tools` if you trust what it tells agents. A chat that was already open may not see a new
  tool until you start another.

## Share a mod

**Export** on a mod's row saves the whole mod as one file, `<name>.synara-mod.json`. On another
computer, choose **Import…** above the list, or drop the file anywhere on the Settings → Mods
page. You can import several files at once.

- An imported mod starts **Off**, like any new mod.
- The file holds every file of the mod's folder except hidden files (such as `.env` and
  `.git`), `node_modules` and links, so secrets and tooling stay behind.
- What the mod saved with `$.store`, whether it was on, your sign-ins and the environment
  variables it reads do not travel. Set those variables on the other computer.
- If a mod with the same name is installed, Synara asks **Replace the installed "<name>" mod?**
  Replacing it turns the mod off, signs it out and swaps its files; what it saved stays, and
  the replaced version is kept in the hidden `.replaced/` folder inside the mods folder.
- An exported mod is limited to 1.5 MB and 200 files. Synara refuses a mod that is a link to a
  folder elsewhere, and any file that would write outside the mod's folder.

## Where mods live and run

- **Mods folder:** `mods/` in Synara's home folder (`~/.synara-beta/mods/` for Synara Beta, or
  `$SYNARA_HOME/mods/`). Synara creates it. The full path is at the top of Settings → Mods.
- **Which mods are on, and what they saved,** are kept in Synara's state folder, apart from the
  mods themselves.
- **Running:** each enabled mod runs in its own worker inside Synara's server process. A window
  connected from another device only draws the mod's views.
- If the system cannot watch the mods folder for changes, use **Reload** after editing a mod.

## Limits

- A mod's code runs with Synara's own access whatever its permissions: they gate what Synara
  lets it do to agents, not what its code can reach. Synara keeps no record of what a mod did.
- Only the owner's own session can turn a mod on, trust its changes, sign in for it, import or
  export one; a paired device can turn one off or sign it out. If an enabled mod's folder is deleted, it is no longer
  trusted: a folder that comes back under that name starts off.
- Hidden files, `node_modules` and links in a mod's folder are not part of what you trust or
  export; a mod cannot import them either.
- A hook may run for 10 seconds of its own time and 60 seconds in all, waits included. A mod
  may keep 4 MB in `$.state` and 1 MB in `$.store`, and show 5 toasts every 10 seconds.
- A mod's denial of an approval matches on what the approval card shows; a provider may
  shorten a long command, so a rule cannot be sure to see text far into one.
