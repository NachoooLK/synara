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
After that, Synara reloads the mod whenever its files change. Each row also has **Reload**,
**Export**, and a **Log** with what the mod wrote and why it failed.

## What a mod can add

| Where              | What it looks like                                                         |
| ------------------ | -------------------------------------------------------------------------- |
| `sidebar` view     | A button in the sidebar rail; its view replaces the thread list while open |
| `dock` view        | A tab next to the thread, opened from the dock's **+** menu                |
| `band` view        | A strip above the composer of the open thread                              |
| `header` view      | One or two buttons in the thread header                                    |
| Commands           | Entries in the command palette (⌘K)                                        |
| Notices and status | Toasts in every window, and a status line in Settings → Mods               |

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

The complete reference, with every event, `$` call, view element and four examples, is the
`synara-mods` skill in [`apps/server/src/mods/skill/`](../apps/server/src/mods/skill/). Synara
installs it under `builtin-skills/synara-mods` in its home folder.

## Share a mod

**Export** on a mod's row saves the whole mod as one file, `<name>.synara-mod.json`. On another
computer, choose **Import…** above the list, or drop the file anywhere on the Settings → Mods
page. You can import several files at once.

- An imported mod starts **Off**, like any new mod.
- The file holds every file of the mod's folder except hidden files (such as `.env` and
  `.git`), `node_modules` and links, so secrets and tooling stay behind.
- What the mod saved with `$.store`, whether it was on, and the environment variables it reads
  do not travel. Set those variables on the other computer.
- If a mod with the same name is installed, Synara asks **Replace the installed "<name>" mod?**
  Replacing it turns the mod off and swaps its files; what it saved stays, and the replaced
  version is kept in the hidden `.replaced/` folder inside the mods folder.
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

- Trust is all or nothing: there are no per-mod permissions, and Synara keeps no record of what
  a mod did. Only the owner's own session can turn a mod on, import or export one; a paired
  device can turn one off. If an enabled mod's folder is deleted, it is no longer trusted: a
  folder that comes back under that name starts off.
- An enabled mod reloads when its files change without asking again, so trust a mod's folder,
  not only its current code.
- A hook may run for 10 seconds of its own time and 60 seconds in all, waits included. A mod
  may keep 4 MB in `$.state` and 1 MB in `$.store`, and show 5 toasts every 10 seconds.
- Mods cannot yet react to agent activity: there are no hooks for sent prompts or tool calls,
  and mods cannot give agents new tools.
