import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderOpen, FolderSearch, RotateCcw, X } from "lucide-react";
import { ScButton, ScInput } from "@storycapture/ui";

import {
  getLogConfig,
  openLogDir,
  setLogConfig,
  type LogConfig,
} from "@/ipc/settings";

import {
  SettingsCard,
  SettingsPanel,
  SettingsRow,
} from "../settings-row";

const BYTES_PER_MIB = 1024 * 1024;

function bytesToMib(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MIB) * 100) / 100;
}

function mibToBytes(mib: number): number {
  return Math.round(mib * BYTES_PER_MIB);
}

interface RangeRule {
  label: string;
  min: number;
  max: number;
  /** Suffix appended to bound numbers in the error message (e.g. " MiB"). */
  unit?: string;
  integer?: boolean;
}

function validateRange(value: number, rule: RangeRule): string | null {
  const unit = rule.unit ?? "";
  if (!Number.isFinite(value)) return `${rule.label} must be a number.`;
  if (rule.integer && !Number.isInteger(value)) {
    return `${rule.label} must be a whole number.`;
  }
  if (value < rule.min) return `${rule.label} must be ≥ ${rule.min}${unit}.`;
  if (value > rule.max) return `${rule.label} must be ≤ ${rule.max}${unit}.`;
  return null;
}

export function LogsCategory() {
  const [config, setConfig] = useState<LogConfig | null>(null);
  const [maxSizeMibInput, setMaxSizeMibInput] = useState("");
  const [maxFilesInput, setMaxFilesInput] = useState("");
  const [logDirInput, setLogDirInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cfg = await getLogConfig();
      setConfig(cfg);
      setMaxSizeMibInput(String(bytesToMib(cfg.max_file_size_bytes)));
      setMaxFilesInput(String(cfg.max_files));
      setLogDirInput(cfg.log_dir_override ?? "");
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sizeRange = useMemo(() => {
    if (!config) return null;
    return {
      minMib: bytesToMib(config.min_file_size_bytes),
      maxMib: bytesToMib(config.max_allowed_file_size_bytes),
    };
  }, [config]);

  const dirty = useMemo(() => {
    if (!config) return false;
    const sizeMib = Number(maxSizeMibInput);
    const files = Number(maxFilesInput);
    const dir = logDirInput.trim() || null;
    return (
      mibToBytes(sizeMib) !== config.max_file_size_bytes ||
      files !== config.max_files ||
      dir !== config.log_dir_override
    );
  }, [config, maxSizeMibInput, maxFilesInput, logDirInput]);

  const validation = useMemo(() => {
    if (!config) return { ok: false, message: "" };
    const sizeMib = Number(maxSizeMibInput);
    const files = Number(maxFilesInput);
    const sizeError = validateRange(sizeMib, {
      label: "Max file size",
      unit: " MiB",
      min: bytesToMib(config.min_file_size_bytes),
      max: bytesToMib(config.max_allowed_file_size_bytes),
    });
    if (sizeError) return { ok: false, message: sizeError };
    const filesError = validateRange(files, {
      label: "Max files",
      min: config.min_files,
      max: config.max_allowed_files,
      integer: true,
    });
    if (filesError) return { ok: false, message: filesError };
    return { ok: true, message: "" };
  }, [config, maxSizeMibInput, maxFilesInput]);

  const save = useCallback(async () => {
    if (!validation.ok) return;
    const sizeMib = Number(maxSizeMibInput);
    const files = Number(maxFilesInput);
    const dir = logDirInput.trim() || null;
    setBusy(true);
    try {
      const next = await setLogConfig({
        log_dir: dir,
        max_file_size_bytes: mibToBytes(sizeMib),
        max_files: files,
      });
      setConfig(next);
      setMaxSizeMibInput(String(bytesToMib(next.max_file_size_bytes)));
      setMaxFilesInput(String(next.max_files));
      setLogDirInput(next.log_dir_override ?? "");
      toast.success("Log settings saved", {
        description: "Restart StoryCapture for changes to take effect.",
      });
    } catch (e) {
      toast.error("Could not save log settings", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [validation.ok, maxSizeMibInput, maxFilesInput, logDirInput]);

  const resetForm = useCallback(() => {
    if (!config) return;
    setMaxSizeMibInput(String(bytesToMib(config.max_file_size_bytes)));
    setMaxFilesInput(String(config.max_files));
    setLogDirInput(config.log_dir_override ?? "");
  }, [config]);

  const restoreDefaults = useCallback(() => {
    setMaxSizeMibInput(String(bytesToMib(10 * BYTES_PER_MIB)));
    setMaxFilesInput("10");
    setLogDirInput("");
  }, []);

  const pickDir = useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      title: "Select log directory",
    });
    if (typeof selected === "string") {
      setLogDirInput(selected);
    }
  }, []);

  const reveal = useCallback(async () => {
    try {
      await openLogDir();
    } catch (e) {
      toast.error("Could not open log folder", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  if (loadError) {
    return (
      <SettingsPanel title="Logs">
        <div style={{ color: "var(--sc-danger, #c33)", fontSize: 13 }}>
          Could not load log settings: {loadError}
        </div>
      </SettingsPanel>
    );
  }

  return (
    <SettingsPanel
      title="Logs"
      desc="StoryCapture writes diagnostic logs to disk. Each log file rotates at the configured size; older files are pruned once the file count limit is reached."
    >
      <SettingsCard>
        <SettingsRow
          label="Max file size (MiB)"
          hint={
            sizeRange
              ? `Per-file rotation threshold (${sizeRange.minMib}–${sizeRange.maxMib} MiB).`
              : "Per-file rotation threshold."
          }
          control={
            <ScInput
              type="number"
              value={maxSizeMibInput}
              onChange={(e) => setMaxSizeMibInput(e.currentTarget.value)}
              min={sizeRange?.minMib ?? 0.0625}
              max={sizeRange?.maxMib ?? 1024}
              step={1}
              style={{ width: 110 }}
              disabled={busy || !config}
            />
          }
        />
        <SettingsRow
          label="Max files"
          hint={
            config
              ? `Total log files retained (${config.min_files}–${config.max_allowed_files}). Older files are deleted on rotation.`
              : "Total log files retained."
          }
          control={
            <ScInput
              type="number"
              value={maxFilesInput}
              onChange={(e) => setMaxFilesInput(e.currentTarget.value)}
              min={config?.min_files ?? 1}
              max={config?.max_allowed_files ?? 100}
              step={1}
              style={{ width: 110 }}
              disabled={busy || !config}
            />
          }
          last
        />
      </SettingsCard>

      <div style={{ marginTop: 24 }}>
        <SettingsCard>
          <SettingsRow
            label="Log folder"
            hint={
              config
                ? config.log_dir_override
                  ? `Override active. Default: ${config.default_log_dir}`
                  : `Using platform default: ${config.default_log_dir}`
                : "Folder where rotated log files are written."
            }
            control={
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <ScInput
                  value={logDirInput}
                  placeholder={config?.default_log_dir ?? ""}
                  onChange={(e) => setLogDirInput(e.currentTarget.value)}
                  icon={<FolderOpen size={12} />}
                  style={{ width: 280 }}
                  disabled={busy || !config}
                />
                <ScButton
                  size="sm"
                  variant="ghost"
                  onClick={() => void pickDir()}
                  disabled={busy || !config}
                  title="Browse for a folder"
                >
                  <FolderSearch size={12} />
                </ScButton>
                {logDirInput.length > 0 && (
                  <ScButton
                    size="sm"
                    variant="ghost"
                    onClick={() => setLogDirInput("")}
                    disabled={busy}
                    title="Clear override (use platform default)"
                  >
                    <X size={12} />
                  </ScButton>
                )}
              </div>
            }
            last
          />
        </SettingsCard>
        {config && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11.5,
              color: "var(--sc-text-4)",
            }}
          >
            Currently writing to{" "}
            <code style={{ fontSize: 11 }}>{config.effective_log_dir}</code>.
          </div>
        )}
      </div>

      {!validation.ok && dirty && (
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: "var(--sc-danger, #c33)",
          }}
        >
          {validation.message}
        </div>
      )}

      <div
        style={{
          marginTop: 20,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <ScButton
          size="sm"
          variant="primary"
          onClick={() => void save()}
          disabled={!dirty || !validation.ok || busy || !config}
        >
          Save
        </ScButton>
        <ScButton
          size="sm"
          variant="ghost"
          onClick={resetForm}
          disabled={!dirty || busy}
        >
          Cancel
        </ScButton>
        <ScButton
          size="sm"
          variant="ghost"
          onClick={restoreDefaults}
          disabled={busy}
          title="Reset inputs to 10 MiB × 10 files, platform default folder"
        >
          <RotateCcw size={12} /> Defaults
        </ScButton>
        <span style={{ flex: 1 }} />
        <ScButton
          size="sm"
          variant="ghost"
          onClick={() => void reveal()}
          disabled={busy || !config}
          title="Open the current log folder in your file browser"
        >
          <FolderOpen size={12} /> Open log folder
        </ScButton>
      </div>

      <div
        style={{
          marginTop: 18,
          padding: 12,
          background: "var(--sc-surface-2)",
          border: "1px solid var(--sc-border)",
          borderRadius: "var(--sc-r-md)",
          fontSize: 11.5,
          color: "var(--sc-text-3)",
          lineHeight: 1.5,
        }}
      >
        Changes apply on the next launch of StoryCapture. Logs are local-only
        — nothing is uploaded.
      </div>
    </SettingsPanel>
  );
}
