// FILE: ModsSettingsPanel.tsx
// Purpose: Settings → Mods. Lists the mods in the mods folder with their state and
//          where their views live, lets the person enable (after a trust prompt),
//          disable, reload and export each one and sign in to its MCP servers, shows
//          its log, and imports exported mods picked with Import… or dropped on the
//          window.
// Layer: Settings panel (Beta-only; the section is hidden on Stable)

import {
  MOD_BUNDLE_LIMITS,
  type ModLogEntry,
  type ModMcpSignIn,
  type ModPermission,
  type ModsImportInput,
  type ModStatus,
  type ModSummary,
} from "@synara/contracts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import {
  SettingsCard,
  SettingsEmptyState,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { abbreviateHomePath } from "~/components/sidebarHoverCardAnchors";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Skeleton } from "~/components/ui/skeleton";
import { StatusChip } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { getRevealInFolderLabel } from "~/lib/fileReferenceContextMenu";
import { FolderOpenIcon } from "~/lib/icons";
import { revealFolderInShell } from "~/lib/revealFolder";
import { cn, getNavigatorPlatform } from "~/lib/utils";
import { ModMcpSignInLine } from "~/mods/ModMcpSignInLine";
import { useModsStore } from "~/mods/modsStore";
import { describeModAdditions, describeModViews } from "~/mods/modsSnapshot.logic";
import { useModFileDrop } from "~/mods/useModFileDrop";
import { ensureNativeApi } from "~/nativeApi";
import { SETTINGS_CARD_ROW_CLASS_NAME } from "~/settingsPanelStyles";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

const STATUS_LABELS: Record<ModStatus, string> = {
  disabled: "Off",
  starting: "Starting",
  running: "Running",
  error: "Error",
  changed: "Changed",
};

const STATUS_DOT_CLASS_NAMES: Record<ModStatus, string> = {
  disabled: "bg-muted-foreground/50",
  starting: "bg-amber-500",
  running: "bg-green-500",
  error: "bg-destructive",
  changed: "bg-amber-500",
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/** A long path, shortened under the home folder and wrapped so its last folder stays visible. */
function ModPath({ path, className }: { path: string; className?: string }) {
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  return (
    <code title={path} className={cn("break-all", className)}>
      {abbreviateHomePath(path, homeDir)}
    </code>
  );
}

/** What each permission lets a mod do, as the person reads it before trusting the mod. */
const PERMISSION_LABELS: Record<ModPermission, string> = {
  prompts: "change the messages you send to agents",
  approvals: "deny tool calls that wait for your approval",
  tools: "give agents new tools",
};

function describeModPermissions(permissions: ReadonlyArray<ModPermission>): string | null {
  if (permissions.length === 0) return null;
  return permissions.map((permission) => PERMISSION_LABELS[permission]).join("; ");
}

/** What the trust prompt says about the mod's sign-ins; two servers on one host read as one. */
function describeModSignIns(signIns: ReadonlyArray<ModMcpSignIn>): ReadonlyArray<string> {
  return [
    ...new Set(
      signIns.map((signIn) =>
        signIn.state === "needed"
          ? `It will ask you to sign in to ${signIn.host}.`
          : `It is signed in to ${signIn.host}, and keeps that sign-in.`,
      ),
    ),
  ];
}

interface ModConfirmRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  /** A choice the person may tick before confirming. */
  readonly option?: { readonly label: string; readonly description: string };
}

interface ModConfirmAnswer {
  readonly confirmed: boolean;
  /** Whether the request's option was ticked; false when it had none. */
  readonly optionChecked: boolean;
}

type ModConfirm = (request: ModConfirmRequest) => Promise<ModConfirmAnswer>;

/** Lets a mod being written keep reloading; anything else stops when its files change. */
const RELOAD_ON_CHANGE_OPTION = {
  label: "Keep reloading it when its files change",
  description:
    "For a mod you or an agent you are watching is writing, until Synara restarts. Otherwise a change stops the mod and Synara asks you again.",
} as const;

/**
 * An in-app confirmation for trusting or replacing a mod. Unlike the desktop's native
 * confirm, whose default button is Yes, Cancel has the focus, so Enter does not trust a mod.
 */
function useModConfirmDialog(): { readonly confirm: ModConfirm; readonly dialog: ReactNode } {
  const [state, setState] = useState<{
    readonly request: ModConfirmRequest;
    readonly resolve: (answer: ModConfirmAnswer) => void;
    readonly open: boolean;
  } | null>(null);
  const [optionChecked, setOptionChecked] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const optionId = useId();

  const confirm: ModConfirm = (request) =>
    new Promise<ModConfirmAnswer>((resolve) => {
      setOptionChecked(false);
      setState((previous) => {
        if (previous?.open) previous.resolve({ confirmed: false, optionChecked: false });
        return { request, resolve, open: true };
      });
    });
  // The request stays set while the dialog animates out.
  const settle = (confirmed: boolean) => {
    if (!state?.open) return;
    state.resolve({ confirmed, optionChecked: confirmed && optionChecked });
    setState({ ...state, open: false });
  };

  const dialog = (
    <AlertDialog
      open={state?.open ?? false}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      {state ? (
        <AlertDialogPopup initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{state.request.title}</AlertDialogTitle>
            <AlertDialogDescription>{state.request.description}</AlertDialogDescription>
            {state.request.option ? (
              <label
                htmlFor={optionId}
                className="flex cursor-pointer items-start gap-2 pt-2 text-ui text-foreground select-none"
              >
                <Checkbox
                  id={optionId}
                  className="mt-0.5"
                  checked={optionChecked}
                  onCheckedChange={(checked) => setOptionChecked(checked === true)}
                />
                <span className="space-y-0.5">
                  <span className="block">{state.request.option.label}</span>
                  <span className="block text-ui-sm text-muted-foreground">
                    {state.request.option.description}
                  </span>
                </span>
              </label>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose ref={cancelRef} render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button size="sm" onClick={() => settle(true)}>
              {state.request.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      ) : null}
    </AlertDialog>
  );
  return { confirm, dialog };
}

interface KeyedLogEntry extends ModLogEntry {
  readonly key: string;
}

function ModLog({ modId, open }: { modId: string; open: boolean }) {
  const [logs, setLogs] = useState<ReadonlyArray<KeyedLogEntry> | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void ensureNativeApi()
      .mods.readLogs({ id: modId })
      .then(
        (result) => {
          if (cancelled) return;
          // Log lines have no id; the log only grows, so time plus position is stable.
          setLogs(
            result.logs.map((entry, position) => ({ ...entry, key: `${entry.at}#${position}` })),
          );
        },
        (error: unknown) => {
          if (cancelled) return;
          toastManager.add({
            type: "error",
            title: "Could not read the mod's log",
            description: errorText(error, "The server did not answer."),
          });
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, modId, refreshCount]);

  return (
    <DisclosureRegion open={open} contentClassName="mt-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm text-muted-foreground">
          {logs === null ? "Loading…" : `${logs.length} line${logs.length === 1 ? "" : "s"}`}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={loading}
          onClick={() => setRefreshCount((count) => count + 1)}
        >
          Refresh
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-ui-xs">
        {logs !== null && logs.length === 0 ? (
          <p className="text-muted-foreground">Nothing logged yet.</p>
        ) : null}
        {(logs ?? []).map((entry) => (
          <p
            key={entry.key}
            className={cn(
              "break-words whitespace-pre-wrap",
              entry.level === "error" && "text-destructive",
              entry.level === "warn" && "text-amber-600 dark:text-amber-400",
            )}
          >
            <span className="text-muted-foreground">
              {new Date(entry.at).toLocaleTimeString()}{" "}
            </span>
            {entry.message}
          </p>
        ))}
      </div>
    </DisclosureRegion>
  );
}

/** Tells the person what an enabled mod added, or why it did not start. */
function announceEnabledMod(id: string, enabled: ModSummary | undefined): void {
  if (enabled?.status === "running") {
    toastManager.add({
      type: "success",
      title: `Enabled the "${id}" mod`,
      description: describeModAdditions(enabled) ?? "It runs in the background.",
    });
  } else if (enabled?.status === "error") {
    toastManager.add({
      type: "error",
      title: `Could not start the "${id}" mod`,
      description: enabled.error ?? "Open its log below to see why.",
    });
  }
}

function ModRow({ mod, confirm }: { mod: ModSummary; confirm: ModConfirm }) {
  const [pending, setPending] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const permissionsText = describeModPermissions(mod.permissions);

  const isChanged = mod.status === "changed";

  // Also how a mod stopped because its files changed is trusted again.
  const setEnabled = async (enabled: boolean) => {
    const api = ensureNativeApi();
    let reloadOnChange = false;
    if (enabled) {
      const answer = await confirm({
        title: isChanged
          ? `Trust the changes to the "${mod.id}" mod?`
          : `Enable the "${mod.id}" mod?`,
        description: [
          isChanged ? "Its files are not the ones you enabled." : null,
          "A mod runs with Synara's own access: it can read your projects and chats and run code on this computer.",
          permissionsText ? `This one also asks to ${permissionsText}.` : null,
          ...describeModSignIns(mod.mcpSignIns),
          "Only enable mods you wrote or trust.",
        ]
          .filter((line) => line !== null)
          .join(" "),
        confirmLabel: isChanged ? "Trust changes" : "Enable mod",
        option: RELOAD_ON_CHANGE_OPTION,
      });
      if (!answer.confirmed) return;
      reloadOnChange = answer.optionChecked;
    }
    setPending(true);
    try {
      const snapshot = await api.mods.setEnabled(
        enabled ? { id: mod.id, enabled, reloadOnChange } : { id: mod.id, enabled },
      );
      useModsStore.getState().setSnapshot(snapshot);
      if (enabled) {
        announceEnabledMod(
          mod.id,
          snapshot.mods.find((candidate) => candidate.id === mod.id),
        );
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: enabled ? "Could not enable the mod" : "Could not disable the mod",
        description: errorText(error, "The server did not answer."),
      });
    } finally {
      setPending(false);
    }
  };

  const reload = async () => {
    setPending(true);
    try {
      useModsStore.getState().setSnapshot(await ensureNativeApi().mods.reload({ id: mod.id }));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not reload the mod",
        description: errorText(error, "The server did not answer."),
      });
    } finally {
      setPending(false);
    }
  };

  const exportMod = async () => {
    const api = ensureNativeApi();
    setPending(true);
    try {
      if (!api.dialogs.saveFile) throw new Error("This window cannot save files.");
      const file = await api.mods.export({ id: mod.id });
      const savedPath = await api.dialogs.saveFile({
        defaultFilename: file.filename,
        contents: file.contents,
        filters: [{ name: "Synara mod", extensions: ["json"] }],
      });
      // In a browser the file downloads instead and there is no path to show.
      if (savedPath) {
        toastManager.add({ type: "success", title: "Mod exported", description: savedPath });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not export the mod",
        description: errorText(error, "The server did not answer."),
      });
    } finally {
      setPending(false);
    }
  };

  const details = [
    mod.version ? `Version ${mod.version}` : null,
    mod.hooks.length > 0 ? `Hooks: ${mod.hooks.join(", ")}` : null,
    mod.commands.length > 0
      ? `Commands: ${mod.commands.map((command) => command.title).join(", ")}`
      : null,
    mod.views.length > 0 ? `Views: ${describeModViews(mod)}` : null,
    mod.pullRequestSources.length > 0
      ? `Code review sources: ${mod.pullRequestSources.map((source) => `${source.title} (${source.source.sourceId})`).join(", ")}`
      : null,
    mod.mcpServers.length > 0 ? `MCP: ${mod.mcpServers.join(", ")}` : null,
    mod.tools.length > 0
      ? `Tools for agents: ${mod.tools.map((tool) => tool.servedName).join(", ")}`
      : null,
    permissionsText ? `May ${permissionsText}` : null,
    mod.reloadsOnChange ? "Reloads when its files change" : null,
  ].filter((detail): detail is string => detail !== null);

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{mod.id}</span>
          <StatusChip
            dotClassName={STATUS_DOT_CLASS_NAMES[mod.status]}
            pulse={mod.status === "starting"}
            className="text-muted-foreground"
          >
            {STATUS_LABELS[mod.status]}
          </StatusChip>
        </span>
      }
      description={mod.description ?? "No description."}
      status={
        <span className="flex min-w-0 flex-col gap-1">
          {mod.statusText ? <span className="text-foreground">{mod.statusText}</span> : null}
          {details.length > 0 ? <span>{details.join(" · ")}</span> : null}
          {mod.mcpSignIns.map((signIn) => (
            // The state is part of the key, so the browser hint goes once the sign-in arrives.
            <ModMcpSignInLine key={`${signIn.server}:${signIn.state}`} mod={mod} signIn={signIn} />
          ))}
          {mod.error ? (
            <span className="line-clamp-4 break-words whitespace-pre-wrap text-destructive">
              {mod.error}
            </span>
          ) : null}
          {isChanged ? (
            <span className="text-warning">
              Its files changed since you enabled it, so it is stopped. Trust the changes to run it
              again.
            </span>
          ) : null}
          <ModPath path={mod.path} />
          <button
            type="button"
            className="inline-flex w-fit items-center text-ui-sm text-muted-foreground hover:text-foreground"
            aria-expanded={logOpen}
            onClick={() => setLogOpen((open) => !open)}
          >
            Log
            <DisclosureChevron open={logOpen} className="ml-1 size-3.5" />
          </button>
        </span>
      }
      control={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={pending || !mod.enabled}
            onClick={() => void reload()}
          >
            Reload
          </Button>
          <Button size="xs" variant="outline" disabled={pending} onClick={() => void exportMod()}>
            Export
          </Button>
          {isChanged ? (
            <Button size="xs" disabled={pending} onClick={() => void setEnabled(true)}>
              Trust changes
            </Button>
          ) : null}
          <Switch
            checked={mod.enabled}
            disabled={pending}
            onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
            aria-label={`Enable the ${mod.id} mod`}
          />
        </>
      }
    >
      <ModLog modId={mod.id} open={logOpen} />
    </SettingsRow>
  );
}

function readModName(bundle: unknown): string | null {
  if (bundle === null || typeof bundle !== "object") return null;
  const name = (bundle as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

/** Imports one exported mod file, asking first when it would replace an installed mod. */
async function importModFile(file: File, confirm: ModConfirm): Promise<void> {
  const api = ensureNativeApi();
  try {
    let bundle: ModsImportInput["bundle"];
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      throw new Error(`"${file.name}" is not an exported Synara mod.`);
    }
    // The mod travels in one WebSocket message; refuse here what the socket would drop.
    if (new Blob([JSON.stringify(bundle)]).size > MOD_BUNDLE_LIMITS.bytes) {
      throw new Error(`An exported mod is limited to ${MOD_BUNDLE_LIMITS.bytes / 1_000_000} MB.`);
    }
    const name = readModName(bundle);
    // Read the store now, not a rendered prop: an earlier file in the same drop may have added it.
    const mods = useModsStore.getState().snapshot?.mods ?? [];
    const installed = name !== null && mods.some((mod) => mod.id === name);
    if (installed) {
      const { confirmed } = await confirm({
        title: `Replace the installed "${name}" mod?`,
        description:
          "Its files will be replaced with the ones in this file and it will stay off until you enable it again. What it has saved stays.",
        confirmLabel: "Replace mod",
      });
      if (!confirmed) return;
    }
    const result = await api.mods.import({ bundle, replace: installed });
    useModsStore.getState().setSnapshot(result.snapshot);
    toastManager.add({
      type: "success",
      title: result.replaced
        ? `Replaced the "${result.id}" mod`
        : `Imported the "${result.id}" mod`,
      description: "It is off. Enable it below once you trust it.",
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not import the mod",
      description: errorText(error, "The server did not answer."),
    });
  }
}

function useModImporter(confirm: ModConfirm) {
  const [pending, setPending] = useState(false);
  const importFiles = async (files: ReadonlyArray<File>) => {
    setPending(true);
    try {
      for (const file of files) await importModFile(file, confirm);
    } finally {
      setPending(false);
    }
  };
  return { pending, importFiles };
}

function ImportModButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: ReadonlyArray<File>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        Import…
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        multiple
        className="hidden"
        aria-label="Import an exported mod"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Clearing the input lets the same file be picked again.
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

/** Placeholder rows shaped like ModRow while the first snapshot loads. */
function ModRowSkeleton() {
  return (
    <div className={SETTINGS_CARD_ROW_CLASS_NAME} aria-hidden="true">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-64 max-w-full" />
          <Skeleton className="h-3 w-48 max-w-full" />
        </div>
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
    </div>
  );
}

function RevealModsFolderButton({ path }: { path: string }) {
  // The desktop opens the folder; a browser has no file manager to show it in.
  if (typeof window === "undefined" || !window.desktopBridge) return null;
  const label = getRevealInFolderLabel(getNavigatorPlatform());
  return (
    <Button size="xs" variant="outline" onClick={() => revealFolderInShell({ path })}>
      <FolderOpenIcon className="size-3.5" />
      {label}
    </Button>
  );
}

export function ModsSettingsPanel() {
  const availability = useModsStore((state) => state.availability);
  const snapshot = useModsStore((state) => state.snapshot);
  const { confirm, dialog: confirmDialog } = useModConfirmDialog();
  const importer = useModImporter(confirm);
  const canImport = availability.kind !== "unavailable" && snapshot !== null;
  const isDropTarget = useModFileDrop({
    enabled: canImport,
    onDrop: (dropped) => {
      if (dropped.kind === "folder") {
        toastManager.add({
          type: "warning",
          title: "Drop an exported mod file",
          description:
            "Only .synara-mod.json files can be dropped here. To add a mod's folder, move it into the mods folder.",
        });
        return;
      }
      void importer.importFiles(dropped.files);
    },
  });

  if (availability.kind === "unavailable") {
    return (
      <SettingsSection title="Mods">
        <SettingsRow title="Mods are not available" description={availability.message} />
      </SettingsSection>
    );
  }

  const mods = snapshot?.mods ?? [];
  const running = mods.filter((mod) => mod.status === "running").length;

  return (
    <div className="space-y-8">
      <SettingsSection title="Mods folder">
        <SettingsRow
          title="Location"
          description="Each mod is a folder here with .synara-mod/mod.json and hooks/hooks.json."
          status={
            snapshot ? (
              <ModPath path={snapshot.modsDir} className="text-ui-sm text-muted-foreground" />
            ) : (
              <Skeleton className="h-3.5 w-72 max-w-full" />
            )
          }
          control={snapshot ? <RevealModsFolderButton path={snapshot.modsDir} /> : undefined}
        />
      </SettingsSection>

      <SettingsSectionShell
        title="Installed mods"
        action={
          <div className="flex items-center gap-2">
            {snapshot !== null && mods.length > 0 ? (
              <span className="text-ui-sm text-muted-foreground">
                {running} of {mods.length} running
              </span>
            ) : null}
            <ImportModButton
              disabled={importer.pending || !canImport}
              onFiles={(files) => void importer.importFiles(files)}
            />
          </div>
        }
      >
        {/* The hint covers the list instead of pushing it down mid-drag. */}
        <div className="relative">
          <SettingsCard>
            {snapshot === null ? (
              <>
                <ModRowSkeleton />
                <ModRowSkeleton />
              </>
            ) : null}
            {snapshot !== null && mods.length === 0 ? (
              <SettingsRow
                title="No mods yet"
                description="Ask an agent to write one with the $synara-mods skill, or import a mod someone exported: choose Import… or drop its file here. To write one by hand, add a folder for it to the mods folder above."
              />
            ) : null}
            {mods.map((mod) => (
              <ModRow key={mod.id} mod={mod} confirm={confirm} />
            ))}
          </SettingsCard>
          {isDropTarget ? (
            <SettingsEmptyState className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-[color:var(--color-border-focus)] bg-background/90 py-0 text-foreground">
              Drop the .synara-mod.json file to import it.
            </SettingsEmptyState>
          ) : null}
        </div>
      </SettingsSectionShell>
      {confirmDialog}
    </div>
  );
}
