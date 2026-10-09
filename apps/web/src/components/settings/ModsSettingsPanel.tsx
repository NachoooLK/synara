// FILE: ModsSettingsPanel.tsx
// Purpose: Settings → Mods. Lists the mods in the mods folder with their state,
//          lets the person enable, disable and reload each one, and shows its log.
// Layer: Settings panel (Beta-only; the section is hidden on Stable)

import type { ModLogEntry, ModStatus, ModSummary } from "@synara/contracts";
import { useEffect, useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { StatusChip } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useModsStore } from "~/mods/modsStore";
import { ensureNativeApi } from "~/nativeApi";

const STATUS_LABELS: Record<ModStatus, string> = {
  disabled: "Off",
  starting: "Starting",
  running: "Running",
  error: "Error",
};

const STATUS_DOT_CLASS_NAMES: Record<ModStatus, string> = {
  disabled: "bg-muted-foreground/50",
  starting: "bg-amber-500",
  running: "bg-green-500",
  error: "bg-destructive",
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
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

function ModRow({ mod }: { mod: ModSummary }) {
  const [pending, setPending] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const setEnabled = async (enabled: boolean) => {
    const api = ensureNativeApi();
    if (enabled) {
      const confirmed = await api.dialogs.confirm(
        [
          `Enable the "${mod.id}" mod?`,
          "A mod runs with Synara's own access: it can read your projects and chats and run code on this computer.",
          "Only enable mods you wrote or trust.",
        ].join("\n"),
      );
      if (!confirmed) return;
    }
    setPending(true);
    try {
      useModsStore.getState().setSnapshot(await api.mods.setEnabled({ id: mod.id, enabled }));
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

  const details = [
    mod.version ? `Version ${mod.version}` : null,
    mod.hooks.length > 0 ? `Hooks: ${mod.hooks.join(", ")}` : null,
    mod.commands.length > 0
      ? `Commands: ${mod.commands.map((command) => command.title).join(", ")}`
      : null,
    mod.views.length > 0 ? `Views: ${mod.views.map((view) => view.title).join(", ")}` : null,
    mod.mcpServers.length > 0 ? `MCP: ${mod.mcpServers.join(", ")}` : null,
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
          {mod.error ? (
            <span className="line-clamp-4 break-words whitespace-pre-wrap text-destructive">
              {mod.error}
            </span>
          ) : null}
          <code className="truncate">{mod.path}</code>
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

export function ModsSettingsPanel() {
  const availability = useModsStore((state) => state.availability);
  const snapshot = useModsStore((state) => state.snapshot);

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
          title="Mods folder"
          description="Each mod is a folder here with .synara-mod/mod.json and hooks/hooks.json. Synara reloads a mod when its files change."
          status={
            snapshot ? (
              <code className="break-all text-ui-sm text-muted-foreground">{snapshot.modsDir}</code>
            ) : null
          }
          control={
            <span className="text-ui leading-snug font-medium text-muted-foreground">
              {snapshot === null
                ? "Loading…"
                : `${running} of ${mods.length} mod${mods.length === 1 ? "" : "s"} running`}
            </span>
          }
        />
      </SettingsSection>

      <SettingsSection title="Installed mods">
        {snapshot !== null && mods.length === 0 ? (
          <SettingsRow
            title="No mods yet"
            description="Create a folder in the mods folder above, or ask an agent to write a mod for you."
          />
        ) : null}
        {mods.map((mod) => (
          <ModRow key={mod.id} mod={mod} />
        ))}
      </SettingsSection>
    </div>
  );
}
