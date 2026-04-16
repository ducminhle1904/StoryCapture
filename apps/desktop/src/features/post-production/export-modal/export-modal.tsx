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
import {
  ChevronRight,
  FolderOpen,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  exportRun,
  exportValidateConfig,
  type ExportOutput,
} from "@/ipc/export";
import { AiDisclosureModal } from "@/features/export/AiDisclosureModal";
import { useVoiceoverStore } from "@/features/voiceover/voiceoverStore";
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
  const ttsClipCount = useVoiceoverStore(
    (s) => Object.keys(s.clipByStepId).length,
  );

  const [submitting, setSubmitting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [disclosureOpen, setDisclosureOpen] = useState(false);

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

  const runExport = useCallback(async () => {
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

  const onSubmit = useCallback(async () => {
    if (ttsClipCount > 0) {
      setDisclosureOpen(true);
      return;
    }
    await runExport();
  }, [runExport, ttsClipCount]);

  const handleDisclosureResult = useCallback(
    async ({ proceed }: { proceed: boolean; embedC2pa: boolean }) => {
      setDisclosureOpen(false);
      if (!proceed) return;
      await runExport();
    },
    [runExport],
  );

  if (!open) return null;

  const selectedFormatsLabel =
    form.formats.length > 0
      ? form.formats.map((format) => format.toUpperCase()).join(" + ")
      : "No format selected";

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/60 backdrop-blur-md"
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
        className="fixed inset-y-3 right-3 z-40 flex w-[min(460px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(14,17,24,0.98),rgba(8,10,15,0.98))] shadow-[0_32px_90px_rgba(0,0,0,0.42)]"
      >
        <header className="relative overflow-hidden border-b border-white/8 px-5 py-5">
          <div className="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_left,rgba(255,106,124,0.2),transparent_58%)]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[var(--color-fg-muted)]">
                <Sparkles className="h-3.5 w-3.5" />
                Export queue
              </div>
              <h2
                id="export-modal-title"
                className="mt-3 text-2xl font-semibold tracking-[-0.045em] text-[var(--color-fg-primary)]"
              >
                Ship this cut
              </h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-[var(--color-fg-secondary)]">
                Choose formats, quality, and destination before sending the render
                job to the queue.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close export dialog"
              onClick={() => setOpen(false)}
              className="rounded-xl border border-white/8 bg-white/4 p-2 text-[var(--color-fg-muted)] transition hover:bg-white/8 hover:text-[var(--color-fg-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-primary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="relative mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-white/8 bg-black/16 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                Formats
              </div>
              <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
                {selectedFormatsLabel}
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/16 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                Resolution
              </div>
              <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
                {form.resolution.toUpperCase()}
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/16 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
                FPS
              </div>
              <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
                {form.fps} fps
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-auto px-5 py-5">
          <section className="rounded-[24px] border border-white/8 bg-white/4 p-4">
            <FormatCheckboxes value={form.formats} onChange={setFormats} />
          </section>

          <section className="rounded-[24px] border border-white/8 bg-white/4 p-4">
            <ResolutionPicker
              value={form.resolution}
              onChange={setResolution}
            />
          </section>

          <section className="rounded-[24px] border border-white/8 bg-white/4 p-4">
            <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
              Motion fidelity
            </div>
            <div className="mt-3 flex gap-2">
              {FPS_CHOICES.map((n) => (
                <label
                  key={n}
                  className={`flex-1 cursor-pointer rounded-2xl border px-3 py-3 text-center text-sm font-medium transition ${
                    form.fps === n
                      ? "border-[var(--color-accent-primary)]/50 bg-[var(--color-accent-primary)]/10 text-[var(--color-fg-primary)] shadow-[0_16px_32px_rgba(0,0,0,0.18)]"
                      : "border-white/8 bg-black/14 text-[var(--color-fg-secondary)] hover:border-white/14 hover:bg-white/5 hover:text-[var(--color-fg-primary)]"
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
          </section>

          <section className="rounded-[24px] border border-white/8 bg-white/4 p-4">
            <div className="grid gap-4">
              <div>
                <label
                  htmlFor="export-quality"
                  className="block text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]"
                >
                  Quality
                </label>
                <select
                  id="export-quality"
                  value={form.quality}
                  onChange={(e) =>
                    setQuality(e.target.value as "low" | "med" | "high")
                  }
                  className="mt-3 w-full rounded-2xl border border-white/8 bg-black/14 px-4 py-3 text-sm text-[var(--color-fg-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-primary)]"
                >
                  <option value="low">Low</option>
                  <option value="med">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="export-basename"
                  className="block text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]"
                >
                  Base file name
                </label>
                <input
                  id="export-basename"
                  type="text"
                  value={form.baseName}
                  onChange={(e) => setBaseName(e.target.value)}
                  className="mt-3 w-full rounded-2xl border border-white/8 bg-black/14 px-4 py-3 text-sm text-[var(--color-fg-primary)] placeholder:text-[var(--color-fg-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-primary)]"
                  aria-label="Export base file name"
                />
              </div>

              <div>
                <span className="block text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
                  Output folder
                </span>
                <div className="mt-3 flex items-center gap-2 rounded-2xl border border-white/8 bg-black/14 p-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/8 bg-white/5 text-[var(--color-fg-muted)]">
                    <FolderOpen className="h-4 w-4" />
                  </div>
                  <input
                    readOnly
                    value={form.outFolder ?? ""}
                    aria-label="Output folder"
                    placeholder="Pick a folder…"
                    className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-fg-secondary)] placeholder:text-[var(--color-fg-muted)] focus:outline-none"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={pickFolder}
                    className="rounded-xl border-white/10 bg-white/4 px-3 text-[var(--color-fg-primary)] hover:bg-white/8"
                  >
                    Pick
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {!graphAvailable ? (
            <section className="rounded-[24px] border border-[var(--color-accent-primary)]/20 bg-[var(--color-accent-primary)]/8 p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-xl border border-[var(--color-accent-primary)]/20 bg-black/20 p-2 text-[var(--color-accent-primary)]">
                  <ChevronRight className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[var(--color-fg-primary)]">
                    Export execution is still gated
                  </div>
                  <p className="mt-1 text-sm leading-6 text-[var(--color-fg-secondary)]">
                    The drawer is ready, but graph computation is not wired yet, so
                    this screen can validate config and collect export choices only.
                  </p>
                </div>
              </div>
            </section>
          ) : null}

          {warnings.length > 0 ? (
            <div
              role="alert"
              className="rounded-[24px] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
            >
              <div className="flex items-center gap-2 font-medium">
                <TriangleAlert className="h-4 w-4" />
                Validation warnings
              </div>
              <ul className="mt-3 list-inside list-disc space-y-1 text-xs text-amber-100/85">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-white/8 bg-black/16 px-5 py-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={runValidate}
            className="rounded-xl px-4 text-[var(--color-fg-secondary)] hover:bg-white/6 hover:text-[var(--color-fg-primary)]"
          >
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
            className="brand-button rounded-xl px-4 text-white disabled:bg-white/10 disabled:text-[var(--color-fg-muted)] disabled:shadow-none"
          >
            {submitting ? "Submitting…" : "Export"}
          </Button>
        </footer>
      </div>
      <AiDisclosureModal
        open={disclosureOpen}
        ttsClipCount={ttsClipCount}
        onResult={(result) => {
          void handleDisclosureResult(result);
        }}
      />
    </>
  );
}
