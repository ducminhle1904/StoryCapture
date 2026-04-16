/**
 * ExportModal (Plan 02-12b, Task 2).
 *
 * Drawer-style dialog for configuring an export run. Reads form state
 * from the Zustand export slice, calls Plan 02-11's `export_run` via the
 * P12a IPC wrapper, and pushes the returned job ids into the queue.
 *
 * Folder picker uses the Tauri dialog plugin directly by command name
 * (`plugin:dialog|open`) so the IPC shape is visible for grep / audit.
 *
 * Validation runs through `exportValidateConfig` per selected output —
 * failures surface as a single inline warning list; the Export button is
 * disabled until all selected outputs validate OR validation has not yet
 * been invoked (initial state).
 */

import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  exportRun,
  exportValidateConfig,
  type ExportOutput,
} from "@/ipc/export";
import { useEditorStore } from "../state/store";
import { FormatCheckboxes } from "./format-checkboxes";
import { ResolutionPicker } from "./resolution-picker";

export interface ExportModalProps {
  storyId: string;
}

const FPS_CHOICES = [24, 30, 60];

export function ExportModal({ storyId }: ExportModalProps) {
  const open = useEditorStore((s) => s.exportModalOpen);
  const setOpen = useEditorStore((s) => s.setExportModalOpen);
  const form = useEditorStore((s) => s.exportForm);
  const setFormats = useEditorStore((s) => s.setExportFormats);
  const setResolution = useEditorStore((s) => s.setExportResolution);
  const setFps = useEditorStore((s) => s.setExportFps);
  const setQuality = useEditorStore((s) => s.setExportQuality);
  const setOutFolder = useEditorStore((s) => s.setExportOutFolder);
  const setBaseName = useEditorStore((s) => s.setExportBaseName);

  const [submitting, setSubmitting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const outputs: ExportOutput[] = useMemo(
    () =>
      form.formats.map((f) => ({
        format: f,
        resolution: form.resolution,
        fps: form.fps,
        quality: form.quality,
      })),
    [form.formats, form.resolution, form.fps, form.quality],
  );

  const pickFolder = useCallback(async () => {
    try {
      const folder = await invoke<string | null>("plugin:dialog|open", {
        options: { directory: true, multiple: false },
      });
      if (folder) setOutFolder(folder);
    } catch (err) {
      toast.error(`Folder picker failed: ${String(err)}`);
    }
  }, [setOutFolder]);

  // Plan 02-13b wires the computed effects graph into this modal; until it
  // lands there is no way to assemble a non-empty `graph_json`, so we block
  // submission entirely rather than silently enqueueing empty-graph jobs.
  const graphAvailable = false;

  const canSubmit =
    !submitting &&
    outputs.length > 0 &&
    !!form.outFolder &&
    form.baseName.trim().length > 0 &&
    warnings.length === 0 &&
    graphAvailable;

  const runValidate = useCallback(async () => {
    const errs: string[] = [];
    for (const cfg of outputs) {
      try {
        await exportValidateConfig(cfg);
      } catch (err) {
        errs.push(`${cfg.format} @ ${cfg.resolution}/${cfg.fps}: ${String(err)}`);
      }
    }
    setWarnings(errs);
    return errs.length === 0;
  }, [outputs]);

  const onSubmit = useCallback(async () => {
    if (!form.outFolder) return;
    setSubmitting(true);
    try {
      const ok = await runValidate();
      if (!ok) {
        toast.error("Export validation failed — fix warnings and retry");
        return;
      }
      // Graph computation is not yet wired (Plan 02-13b); `canSubmit`
      // gates the button behind `graphAvailable = false`, so this path
      // should be unreachable. Guard defensively so we never submit an
      // empty graph to the backend.
      if (!graphAvailable) {
        toast.error("Graph computation pending (Plan 02-13b)");
        return;
      }
      const res = await exportRun({
        story_id: storyId,
        graph_json: "",
        outputs,
        priority: 0,
        output_folder: form.outFolder,
        base_name: form.baseName,
        preset_id: null,
      });
      toast.success(`Export queued: ${res.job_ids.length} jobs`);
      setOpen(false);
    } catch (err) {
      toast.error(`Export failed: ${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }, [form.outFolder, form.baseName, outputs, runValidate, storyId, setOpen]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/40"
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
        className="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 id="export-modal-title" className="text-sm font-semibold">
            Export
          </h2>
          <button
            type="button"
            aria-label="Close export dialog"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-auto p-4">
          <FormatCheckboxes value={form.formats} onChange={setFormats} />

          <ResolutionPicker value={form.resolution} onChange={setResolution} />

          <div>
            <label className="block text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
              Frames per second
            </label>
            <div className="mt-1 flex gap-2">
              {FPS_CHOICES.map((n) => (
                <label
                  key={n}
                  className={`cursor-pointer rounded border px-2 py-1 text-sm ${
                    form.fps === n
                      ? "border-[var(--color-accent,#ff5b76)] bg-[var(--color-surface-hi)] text-[var(--color-fg)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="export-fps"
                    value={n}
                    checked={form.fps === n}
                    onChange={() => setFps(n)}
                    className="sr-only"
                  />
                  {n}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="export-quality"
              className="block text-xs uppercase tracking-wide text-[var(--color-fg-muted)]"
            >
              Quality
            </label>
            <select
              id="export-quality"
              value={form.quality}
              onChange={(e) =>
                setQuality(e.target.value as "low" | "med" | "high")
              }
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
            >
              <option value="low">Low</option>
              <option value="med">Medium</option>
              <option value="high">High</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="export-basename"
              className="block text-xs uppercase tracking-wide text-[var(--color-fg-muted)]"
            >
              Base file name
            </label>
            <input
              id="export-basename"
              type="text"
              value={form.baseName}
              onChange={(e) => setBaseName(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-fg)]"
              aria-label="Export base file name"
            />
          </div>

          <div>
            <span className="block text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
              Output folder
            </span>
            <div className="mt-1 flex items-center gap-2">
              <input
                readOnly
                value={form.outFolder ?? ""}
                aria-label="Output folder"
                placeholder="Pick a folder…"
                className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-fg-muted)]"
              />
              <Button variant="outline" size="sm" onClick={pickFolder}>
                Pick…
              </Button>
            </div>
          </div>

          {warnings.length > 0 ? (
            <div
              role="alert"
              className="rounded border border-amber-700 bg-amber-900/40 p-2 text-xs text-amber-200"
            >
              <div className="mb-1 font-semibold">Validation warnings</div>
              <ul className="list-inside list-disc space-y-0.5">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={runValidate}>
            Validate
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!canSubmit}
            aria-disabled={!canSubmit}
            onClick={onSubmit}
            aria-label="Start export"
            title={
              !graphAvailable
                ? "Graph computation pending (Plan 02-13b)"
                : undefined
            }
          >
            {submitting ? "Submitting…" : "Export"}
          </Button>
        </footer>
      </div>
    </>
  );
}
