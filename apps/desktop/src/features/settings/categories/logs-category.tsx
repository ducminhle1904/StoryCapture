import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { NumberInput as AstryxNumberInput } from "@astryxdesign/core/NumberInput";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderSearch, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getLogConfig, type LogConfig, openLogDir, setLogConfig } from "@/ipc/settings";
import { notifications } from "@/lib/notifications";

import { SettingsCard, SettingsPanel, SettingsRow } from "../settings-row";

const BYTES_PER_MIB = 1024 * 1024;

function bytesToMib(bytes: number | bigint): number {
  const value = typeof bytes === "bigint" ? Number(bytes) : bytes;
  return Math.round((value / BYTES_PER_MIB) * 100) / 100;
}

function mibToBytes(mib: number): bigint {
  return BigInt(Math.round(mib * BYTES_PER_MIB));
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
  const [maxSizeMibInput, setMaxSizeMibInput] = useState(0);
  const [maxFilesInput, setMaxFilesInput] = useState(0);
  const [logDirInput, setLogDirInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cfg = await getLogConfig();
      setConfig(cfg);
      setMaxSizeMibInput(bytesToMib(cfg.max_file_size_bytes));
      setMaxFilesInput(cfg.max_files);
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
      setMaxSizeMibInput(bytesToMib(next.max_file_size_bytes));
      setMaxFilesInput(next.max_files);
      setLogDirInput(next.log_dir_override ?? "");
      notifications.success("Log settings saved", {
        description: "Restart StoryCapture for changes to take effect.",
      });
    } catch (e) {
      notifications.error("Could not save log settings", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [validation.ok, maxSizeMibInput, maxFilesInput, logDirInput]);

  const resetForm = useCallback(() => {
    if (!config) return;
    setMaxSizeMibInput(bytesToMib(config.max_file_size_bytes));
    setMaxFilesInput(config.max_files);
    setLogDirInput(config.log_dir_override ?? "");
  }, [config]);

  const restoreDefaults = useCallback(() => {
    setMaxSizeMibInput(bytesToMib(10 * BYTES_PER_MIB));
    setMaxFilesInput(10);
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
      notifications.error("Could not open log folder", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  if (loadError) {
    return (
      <SettingsPanel title="Logs">
        <div style={{ color: "var(--color-error, #c33)", fontSize: 13 }}>
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
            <AstryxNumberInput
              label="Max file size"
              isLabelHidden
              value={maxSizeMibInput}
              onChange={setMaxSizeMibInput}
              min={sizeRange?.minMib ?? 0.0625}
              max={sizeRange?.maxMib ?? 1024}
              step={1}
              style={{ width: 110 }}
              isDisabled={busy || !config}
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
            <AstryxNumberInput
              label="Max files"
              isLabelHidden
              value={maxFilesInput}
              onChange={setMaxFilesInput}
              min={config?.min_files ?? 1}
              max={config?.max_allowed_files ?? 100}
              step={1}
              style={{ width: 110 }}
              isDisabled={busy || !config}
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
                <AstryxTextInput
                  label="Log folder"
                  isLabelHidden
                  value={logDirInput}
                  placeholder={config?.default_log_dir ?? ""}
                  onChange={setLogDirInput}
                  startIcon={<FolderOpen size={12} />}
                  style={{ width: 280 }}
                  isDisabled={busy || !config}
                />
                <AstryxButton
                  size="sm"
                  variant="ghost"
                  onClick={() => void pickDir()}
                  isDisabled={busy || !config}
                  tooltip="Browse for a folder"
                  label="Browse for a folder"
                >
                  <FolderSearch size={12} />
                </AstryxButton>
                {logDirInput.length > 0 && (
                  <AstryxButton
                    size="sm"
                    variant="ghost"
                    onClick={() => setLogDirInput("")}
                    isDisabled={busy}
                    tooltip="Clear override (use platform default)"
                    label="Clear override (use platform default)"
                  >
                    <X size={12} />
                  </AstryxButton>
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
              color: "var(--color-text-disabled)",
            }}
          >
            Currently writing to <code style={{ fontSize: 11 }}>{config.effective_log_dir}</code>.
          </div>
        )}
      </div>

      {!validation.ok && dirty && (
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: "var(--color-error, #c33)",
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
        <AstryxButton
          size="sm"
          variant="primary"
          onClick={() => void save()}
          isDisabled={!dirty || !validation.ok || busy || !config}
          label="Save"
        >
          Save
        </AstryxButton>
        <AstryxButton
          size="sm"
          variant="ghost"
          onClick={resetForm}
          isDisabled={!dirty || busy}
          label="Cancel"
        >
          Cancel
        </AstryxButton>
        <AstryxButton
          size="sm"
          variant="ghost"
          onClick={restoreDefaults}
          isDisabled={busy}
          tooltip="Reset inputs to 10 MiB × 10 files, platform default folder"
          label="Reset inputs to 10 MiB × 10 files, platform default folder"
        >
          <RotateCcw size={12} /> Defaults
        </AstryxButton>
        <span style={{ flex: 1 }} />
        <AstryxButton
          size="sm"
          variant="ghost"
          onClick={() => void reveal()}
          isDisabled={busy || !config}
          tooltip="Open the current log folder in your file browser"
          label="Open the current log folder in your file browser"
        >
          <FolderOpen size={12} /> Open log folder
        </AstryxButton>
      </div>

      <div
        style={{
          marginTop: 18,
          padding: 12,
          background: "var(--color-background-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-element)",
          fontSize: 11.5,
          color: "var(--color-text-secondary)",
          lineHeight: 1.5,
        }}
      >
        Changes apply on the next launch of StoryCapture. Logs are local-only — nothing is uploaded.
      </div>
    </SettingsPanel>
  );
}
