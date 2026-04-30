/**
 * ExportModal — drawer-style dialog for configuring an export run.
 * Reads form state from the Zustand export slice, calls `export_run`
 * via the IPC wrapper, and pushes returned job ids into the queue.
 *
 * Folder picker uses the Tauri dialog plugin directly by command name
 * (`plugin:dialog|open`) so the IPC shape is visible for grep / audit.
 *
 * Validation runs through `exportValidateConfig` per selected output —
 * failures surface as a single inline warning list; the Export button
 * is disabled until all selected outputs validate OR validation has not
 * yet been invoked (initial state).
 */

import { Dialog } from "@base-ui-components/react/dialog";
import type { EncoderOptionsDto, HardwareEncoderDto } from "@storycapture/shared-types";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, FolderOpen, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  dialogBackdropMotionClassName,
  dialogSideSheetPopupMotionClassName,
  dialogSideSheetViewportClassName,
} from "@/components/ui/dialog-motion";
import { AiDisclosureModal } from "@/features/export/AiDisclosureModal";
import { ScButton } from "@storycapture/ui";
import { useVoiceoverStore } from "@/features/voiceover/voiceoverStore";
import { type ExportOutput, exportRun, exportValidateConfig } from "@/ipc/export";
import { type ExportKnobs, useOutputPrefsStore } from "@/state/output-prefs";

import { computeGraph, graphIsRenderable } from "../state/compute-graph";
import { useEditorStore } from "../state/store";
import { AdvancedOutputOptions } from "./advanced-output-options";
import { FormatCheckboxes } from "./format-checkboxes";
import { ResolutionPicker } from "./resolution-picker";

const HW_UI_TO_DTO: Record<string, HardwareEncoderDto> = {
  "h264-videotoolbox": "video-toolbox-h264",
  "hevc-videotoolbox": "video-toolbox-hevc",
  "h264-nvenc": "nvenc-h264",
  "h264-qsv": "qsv-h264",
  "h264-amf": "amf-h264",
  libopenh264: "openh-264-software",
  software: "libx264-software",
  libx264: "libx264-software",
};

function buildEncoderOptions(knobs: ExportKnobs): EncoderOptionsDto {
  const hw = HW_UI_TO_DTO[knobs.hwEncoder] ?? null;
  return {
    container: knobs.container,
    codec: knobs.codec,
    rate_control: knobs.rateControl,
    hw_encoder: hw,
    x264_preset: knobs.x264Preset,
    keyframe_interval_sec: knobs.keyframeSec,
    downscale_algo: knobs.downscaleAlgo,
    audio: {
      codec: knobs.audio.codec,
      bitrate_kbps: knobs.audio.bitrateKbps,
      channels: knobs.audio.channels,
      sample_rate_hz: knobs.audio.sampleRateHz,
    },
  };
}

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
  const ttsClipCount = useVoiceoverStore((s) => Object.keys(s.clipByStepId).length);

  const [submitting, setSubmitting] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [disclosureOpen, setDisclosureOpen] = useState(false);

  const exportKnobs = useOutputPrefsStore((s) => s.exportKnobs);

  const outputs: ExportOutput[] = useMemo(() => {
    // encoder_options sourced from useOutputPrefsStore.
    const encoderOptions = buildEncoderOptions(exportKnobs);
    return form.formats.map((f) => ({
      format: f,
      resolution: form.resolution,
      fps: form.fps,
      quality: form.quality,
      encoder_options: encoderOptions,
    }));
  }, [form.formats, form.resolution, form.fps, form.quality, exportKnobs]);

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

  // Project the timeline into a Graph. We subscribe only to the slices
  // computeGraph reads (tracks + form + undo extras) so React's snapshot equality check
  // doesn't loop on the fresh object that `computeGraph` returns.
  // `graphAvailable` gates submission so we never enqueue an empty-graph
  // job (e.g. project opened with no video clips).
  const tracks = useEditorStore((s) => s.tracks);
  const undoExtras = useEditorStore((s) => s._undoExtras);
  const graph = useMemo(
    () => computeGraph({ tracks, exportForm: form, _undoExtras: undoExtras }),
    [tracks, form, undoExtras],
  );
  const graphAvailable = graphIsRenderable(graph);

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
      // Defensive: `canSubmit` already gates on `graphAvailable`, but
      // re-check here so a race between render and submit can't slip an
      // empty graph through to the backend.
      if (!graphAvailable) {
        toast.error("Nothing to export — add a video clip to the timeline");
        return;
      }
      const res = await exportRun({
        story_id: storyId,
        graph_json: JSON.stringify(graph),
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
  }, [form.outFolder, form.baseName, outputs, runValidate, storyId, setOpen, graph, graphAvailable]);

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

  const selectedFormatsLabel =
    form.formats.length > 0
      ? form.formats.map((format) => format.toUpperCase()).join(" + ")
      : "No format selected";

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop
            className={`fixed inset-0 z-30 bg-[var(--sc-text)/50] backdrop-blur-md ${dialogBackdropMotionClassName}`}
          />
          <Dialog.Viewport className={dialogSideSheetViewportClassName}>
            <Dialog.Popup
              aria-labelledby="export-modal-title"
              className={`pointer-events-auto flex h-full w-[min(460px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[var(--sc-r-xl)] border border-[var(--sc-border-2)] bg-[var(--sc-surface)] shadow-[var(--shadow-card)] ${dialogSideSheetPopupMotionClassName}`}
            >
              <header className="relative overflow-hidden border-b border-[var(--sc-border)] px-5 py-5">
                <div className="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_left,rgba(255,106,124,0.2),transparent_58%)]" />
                <div className="relative flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[var(--sc-text-4)]">
                      <Sparkles className="h-3.5 w-3.5" />
                      Export queue
                    </div>
                    <h2
                      id="export-modal-title"
                      className="mt-3 text-2xl font-semibold tracking-[-0.045em] text-[var(--sc-text)]"
                    >
                      Ship this cut
                    </h2>
                    <p className="font-serif mt-2 max-w-sm text-sm leading-6 text-[var(--sc-text-3)]">
                      Choose formats, quality, and destination before sending the render job to the
                      queue.
                    </p>
                  </div>
                  <Dialog.Close
                    render={<button type="button" aria-label="Close export dialog" />}
                    className="rounded-xl border border-[var(--sc-border)] bg-[var(--sc-surface)] p-2 text-[var(--sc-text-4)] transition hover:bg-[var(--sc-surface-2)] hover:text-[var(--sc-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sc-accent-500)]"
                  >
                    <X className="h-4 w-4" />
                  </Dialog.Close>
                </div>

                <div className="relative mt-5 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--sc-text-4)]">
                      Formats
                    </div>
                    <div className="mt-2 text-sm font-medium text-[var(--sc-text)]">
                      {selectedFormatsLabel}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--sc-text-4)]">
                      Resolution
                    </div>
                    <div className="mt-2 text-sm font-medium text-[var(--sc-text)]">
                      {form.resolution.toUpperCase()}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--sc-text-4)]">
                      FPS
                    </div>
                    <div className="mt-2 text-sm font-medium text-[var(--sc-text)]">
                      {form.fps} fps
                    </div>
                  </div>
                </div>
              </header>

              <div className="flex-1 space-y-4 overflow-auto px-5 py-5">
                <section className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                  <FormatCheckboxes value={form.formats} onChange={setFormats} />
                </section>

                <section className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                  <ResolutionPicker value={form.resolution} onChange={setResolution} />
                </section>

                <section className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--sc-text-4)]">
                    Motion fidelity
                  </div>
                  <div className="mt-3 flex gap-2">
                    {FPS_CHOICES.map((n) => (
                      <label
                        key={n}
                        className={`flex-1 cursor-pointer rounded-2xl border px-3 py-3 text-center text-sm font-medium transition ${
                          form.fps === n
                            ? "border-[var(--sc-accent-500)]/50 bg-[var(--sc-accent-500)]/10 text-[var(--sc-text)] shadow-[0_16px_32px_rgba(0,0,0,0.18)]"
                            : "border-[var(--sc-border)] bg-[var(--sc-surface-2)] text-[var(--sc-text-3)] hover:border-[var(--sc-border-2)] hover:bg-[var(--sc-surface)] hover:text-[var(--sc-text)]"
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

                <section className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                  <div className="grid gap-4">
                    <div>
                      <label
                        htmlFor="export-quality"
                        className="block text-[11px] uppercase tracking-[0.2em] text-[var(--sc-text-4)]"
                      >
                        Quality
                      </label>
                      <select
                        id="export-quality"
                        value={form.quality}
                        onChange={(e) => setQuality(e.target.value as "low" | "med" | "high")}
                        className="mt-3 w-full rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-4 py-3 text-sm text-[var(--sc-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sc-accent-500)]"
                      >
                        <option value="low">Low</option>
                        <option value="med">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="export-basename"
                        className="block text-[11px] uppercase tracking-[0.2em] text-[var(--sc-text-4)]"
                      >
                        Base file name
                      </label>
                      <input
                        id="export-basename"
                        type="text"
                        value={form.baseName}
                        onChange={(e) => setBaseName(e.target.value)}
                        className="mt-3 w-full rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-4 py-3 text-sm text-[var(--sc-text)] placeholder:text-[var(--sc-text-4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sc-accent-500)]"
                        aria-label="Export base file name"
                      />
                    </div>

                    <div>
                      <span className="block text-[11px] uppercase tracking-[0.2em] text-[var(--sc-text-4)]">
                        Output folder
                      </span>
                      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-[var(--sc-border)] bg-[var(--sc-surface-2)] p-2">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--sc-border)] bg-[var(--sc-surface)] text-[var(--sc-text-4)]">
                          <FolderOpen className="h-4 w-4" />
                        </div>
                        <input
                          readOnly
                          value={form.outFolder ?? ""}
                          aria-label="Output folder"
                          placeholder="Pick a folder…"
                          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--sc-text-3)] placeholder:text-[var(--sc-text-4)] focus:outline-none"
                        />
                        <ScButton variant="default" size="sm" onClick={pickFolder}>
                          Pick
                        </ScButton>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                  <Accordion>
                    <AccordionItem value="advanced">
                      <AccordionTrigger>Advanced options</AccordionTrigger>
                      <AccordionContent>
                        <AdvancedOutputOptions />
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </section>

                {!graphAvailable ? (
                  <section className="rounded-[var(--sc-r-xl)] border border-[var(--sc-accent-500)]/20 bg-[var(--sc-accent-500)]/8 p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-xl border border-[var(--sc-accent-500)]/20 bg-[var(--sc-surface-2)] p-2 text-[var(--sc-accent-500)]">
                        <ChevronRight className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-[var(--sc-text)]">
                          Nothing to export yet
                        </div>
                        <p className="font-serif mt-1 text-sm leading-6 text-[var(--sc-text-3)]">
                          Add a video clip with a source path to the timeline, then this
                          drawer will assemble the render graph automatically.
                        </p>
                      </div>
                    </div>
                  </section>
                ) : null}

                {warnings.length > 0 ? (
                  <div
                    role="alert"
                    className="rounded-[var(--sc-r-xl)] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
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

              <footer className="flex items-center justify-between border-t border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-5 py-4">
                <ScButton variant="ghost" size="sm" onClick={runValidate}>
                  Validate
                </ScButton>
                <ScButton
                  variant="primary"
                  size="sm"
                  disabled={!canSubmit}
                  aria-disabled={!canSubmit}
                  onClick={onSubmit}
                  aria-label="Start export"
                  title={!graphAvailable ? "Add a video clip with a sourcePath to the timeline" : undefined}
                >
                  {submitting ? "Submitting…" : "Export"}
                </ScButton>
              </footer>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
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
