/**
 * ExportModal — drawer-style dialog for configuring an export run.
 * Reads form state from the Zustand export slice, calls `export_run`
 * via the IPC wrapper, and pushes returned job ids into the queue.
 *
 * Folder picker uses the Tauri dialog plugin directly by command name
 * (`plugin:dialog|open`) so the IPC shape is visible for grep / audit.
 *
 * Validation runs through typed graph-aware `export_preflight`; errors block
 * submission while warnings and informational disclosures remain visible.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { Dialog } from "@astryxdesign/core/Dialog";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import type { ExportIssue } from "@storycapture/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, FolderOpen, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { AiDisclosureModal } from "@/features/export/AiDisclosureModal";
import {
  type AiDisclosure,
  type ExportEncoderOptions,
  type ExportOutput,
  exportPreflight,
  exportRun,
} from "@/ipc/export";
import { RENDER_KEYS } from "@/ipc/render";
import { notifications } from "@/lib/notifications";
import { DEFAULT_EXPORT_KNOBS, type ExportKnobs, useOutputPrefsStore } from "@/state/output-prefs";

import { compileExportComposition, graphIsRenderable } from "../state/compute-graph";
import type { ExportFormat } from "../state/export-slice";
import { useEditorStore } from "../state/store";
import { AdvancedOutputOptions } from "./advanced-output-options";
import { deriveQualityControls } from "./encoder-options-table";
import { ResolutionPicker } from "./resolution-picker";

export function buildEncoderOptions(knobs: ExportKnobs): ExportEncoderOptions {
  const controls = deriveQualityControls(knobs.hwEncoder, knobs.codec);
  const rateControl = controls.rateControlOptions.some(
    (option) => option.value === knobs.rateControl,
  )
    ? knobs.rateControl
    : controls.defaultRateControl;
  const encoderPreset = controls.presetOptions.includes(knobs.encoderPreset)
    ? knobs.encoderPreset
    : controls.defaultPreset;
  return {
    container: knobs.container,
    codec: knobs.codec,
    rate_control: rateControl,
    hw_encoder: controls.backendEncoder,
    quality_value: knobs.hwEncoder === "auto" ? controls.defaultQualityValue : knobs.qualityValue,
    encoder_preset: encoderPreset,
    keyframe_interval_sec: knobs.keyframeSec,
    resampling_quality: knobs.resamplingQuality,
    audio: {
      codec: knobs.audio.codec,
      bitrate_kbps: knobs.audio.bitrateKbps,
      channels: knobs.audio.channels,
      sample_rate_hz: knobs.audio.sampleRateHz,
    },
  };
}

function encoderOptionsForOutput(
  options: ExportEncoderOptions,
  format: ExportOutput["format"],
): ExportEncoderOptions {
  if (format === "webm") {
    return {
      ...options,
      container: "webm",
      audio: options.audio ? { ...options.audio, codec: "opus" } : null,
    };
  }
  if (format === "mp4") {
    return {
      ...options,
      container: "mp4",
      audio: {
        codec: DEFAULT_EXPORT_KNOBS.audio.codec,
        bitrate_kbps: DEFAULT_EXPORT_KNOBS.audio.bitrateKbps,
        channels: DEFAULT_EXPORT_KNOBS.audio.channels,
        sample_rate_hz: DEFAULT_EXPORT_KNOBS.audio.sampleRateHz,
      },
    };
  }
  return { ...options, container: null, audio: null };
}

export interface ExportModalProps {
  storyId: string;
}

const FPS_CHOICES = [24, 30, 60];
const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string }> = [
  { value: "mp4", label: "MP4 (H.264 + AAC)" },
  { value: "webm", label: "WebM (VP9)" },
  { value: "gif", label: "GIF (animated)" },
];

export function ExportModal({ storyId }: ExportModalProps) {
  const queryClient = useQueryClient();
  const open = useEditorStore((s) => s.exportModalOpen);
  const setOpen = useEditorStore((s) => s.setExportModalOpen);
  const form = useEditorStore((s) => s.exportForm);
  const setFormats = useEditorStore((s) => s.setExportFormats);
  const setResolution = useEditorStore((s) => s.setExportResolution);
  const setCustomSize = useEditorStore((s) => s.setExportCustomSize);
  const setFps = useEditorStore((s) => s.setExportFps);
  const setQuality = useEditorStore((s) => s.setExportQuality);
  const setFrameMode = useEditorStore((s) => s.setExportFrameMode);
  const setOutFolder = useEditorStore((s) => s.setExportOutFolder);
  const setBaseName = useEditorStore((s) => s.setExportBaseName);
  const ttsClipCount = useEditorStore(
    (s) => s.tracks.sound.filter((clip) => clip.kind === "voiceover").length,
  );

  const [submitting, setSubmitting] = useState(false);
  const [preflightIssues, setPreflightIssues] = useState<ExportIssue[]>([]);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const defaultAiDisclosure = useMemo<AiDisclosure>(
    () => ({ contains_ai_voiceover: ttsClipCount > 0, embed_xmp: ttsClipCount > 0 }),
    [ttsClipCount],
  );

  const exportKnobs = useOutputPrefsStore((s) => s.exportKnobs);

  const pickFolder = useCallback(async () => {
    try {
      const folder = await invoke<string | null>("plugin:dialog|open", {
        options: { directory: true, multiple: false },
      });
      if (folder) setOutFolder(folder);
    } catch (err) {
      notifications.error(`Folder picker failed: ${String(err)}`);
    }
  }, [setOutFolder]);

  // Project the timeline into a Graph. We subscribe only to the slices
  // The compiler reads tracks + form + undo extras. Keep the subscription
  // narrow so React does not loop on the fresh compilation result.
  // `graphAvailable` gates submission so we never enqueue an empty-graph
  // job (e.g. project opened with no video clips).
  const tracks = useEditorStore((s) => s.tracks);
  const undoExtras = useEditorStore((s) => s._undoExtras);
  const compilation = useMemo(
    () => compileExportComposition({ tracks, exportForm: form, _undoExtras: undoExtras }),
    [tracks, form, undoExtras],
  );
  const graph = compilation.graph;
  const graphAvailable = graphIsRenderable(graph);

  const outputs: ExportOutput[] = useMemo(() => {
    const encoderOptions = buildEncoderOptions(exportKnobs);
    return form.formats.map((f) => ({
      format: f,
      resolution: form.resolution,
      output_width: graph.output_width,
      output_height: graph.output_height,
      fps: form.fps,
      quality: form.quality,
      encoder_options: encoderOptionsForOutput(encoderOptions, f),
    }));
  }, [
    form.formats,
    form.resolution,
    form.fps,
    form.quality,
    exportKnobs,
    graph.output_width,
    graph.output_height,
  ]);

  const canSubmit =
    !submitting &&
    outputs.length > 0 &&
    !!form.outFolder &&
    form.baseName.trim().length > 0 &&
    !preflightIssues.some((issue) => issue.severity === "error") &&
    graphAvailable;

  const runValidate = useCallback(
    async (aiDisclosure = defaultAiDisclosure) => {
      const result = await exportPreflight({
        graph_json: JSON.stringify(graph),
        outputs,
        compiler_issues: compilation.issues,
        ai_disclosure: aiDisclosure,
      });
      setPreflightIssues(result.issues);
      return result.ready;
    },
    [compilation.issues, defaultAiDisclosure, graph, outputs],
  );

  const runExport = useCallback(
    async (aiDisclosure: AiDisclosure) => {
      if (!form.outFolder) return;
      setSubmitting(true);
      try {
        const ok = await runValidate(aiDisclosure);
        if (!ok) {
          notifications.error("Export validation failed — fix warnings and retry");
          return;
        }
        // Defensive: `canSubmit` already gates on `graphAvailable`, but
        // re-check here so a race between render and submit can't slip an
        // empty graph through to the backend.
        if (!graphAvailable) {
          notifications.error("Nothing to export — add a video clip to the timeline");
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
          ai_disclosure: aiDisclosure,
        });
        void queryClient.invalidateQueries({ queryKey: RENDER_KEYS.listActive(storyId) });
        notifications.success(
          `Export started: ${res.job_ids.length} job${res.job_ids.length === 1 ? "" : "s"} queued`,
        );
        setOpen(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setPreflightIssues([
          {
            id: "export.start-failed",
            code: "export.start-failed",
            severity: "error",
            message,
            remediation: "Check the output folder and retry the export.",
          },
        ]);
        notifications.error(`Export failed: ${message}`);
      } finally {
        setSubmitting(false);
      }
    },
    [
      form.outFolder,
      form.baseName,
      outputs,
      runValidate,
      storyId,
      setOpen,
      graph,
      graphAvailable,
      queryClient,
    ],
  );

  const onSubmit = useCallback(async () => {
    if (ttsClipCount > 0) {
      setDisclosureOpen(true);
      return;
    }
    await runExport(defaultAiDisclosure);
  }, [defaultAiDisclosure, runExport, ttsClipCount]);

  const handleDisclosureResult = useCallback(
    async ({ proceed, embedXmp }: { proceed: boolean; embedXmp: boolean }) => {
      setDisclosureOpen(false);
      if (!proceed) return;
      await runExport({ contains_ai_voiceover: true, embed_xmp: embedXmp });
    },
    [runExport],
  );

  const selectedFormatsLabel =
    form.formats.length > 0
      ? form.formats.map((format) => format.toUpperCase()).join(" + ")
      : "No format selected";

  return (
    <>
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        purpose="form"
        width="min(460px, calc(100vw - 1.5rem))"
        maxHeight="calc(100dvh - 1.5rem)"
        position={{ right: "0.75rem", top: "0.75rem", bottom: "0.75rem" }}
        padding={0}
        aria-labelledby="export-modal-title"
      >
        <div className="flex max-h-[calc(100dvh-1.5rem)] min-h-0 flex-col overflow-hidden">
          <header className="relative overflow-hidden border-b border-[var(--color-border)] px-5 py-5">
            <div className="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top_left,rgba(255,106,124,0.2),transparent_58%)]" />
            <div className="relative flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[var(--color-text-disabled)]">
                  <Sparkles className="h-3.5 w-3.5" />
                  Export queue
                </div>
                <h2
                  id="export-modal-title"
                  className="mt-3 text-2xl font-semibold tracking-[-0.045em] text-[var(--color-text-primary)]"
                >
                  Ship this cut
                </h2>
                <p className="font-serif mt-2 max-w-sm text-sm leading-6 text-[var(--color-text-secondary)]">
                  Choose formats, quality, and destination before sending the render job to the
                  queue.
                </p>
              </div>
              <AstryxButton
                label="Close export dialog"
                icon={<X className="h-4 w-4" />}
                isIconOnly
                variant="ghost"
                onClick={() => setOpen(false)}
              />
            </div>

            <div className="relative mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-card)] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-disabled)]">
                  Formats
                </div>
                <div className="mt-2 text-sm font-medium text-[var(--color-text-primary)]">
                  {selectedFormatsLabel}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-card)] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-disabled)]">
                  Resolution
                </div>
                <div className="mt-2 text-sm font-medium text-[var(--color-text-primary)]">
                  {form.resolution === "match-source"
                    ? `${graph.output_width}x${graph.output_height}`
                    : form.resolution.toUpperCase()}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-card)] px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-disabled)]">
                  FPS
                </div>
                <div className="mt-2 text-sm font-medium text-[var(--color-text-primary)]">
                  {form.fps} fps
                </div>
              </div>
            </div>
          </header>

          <div className="flex-1 space-y-4 overflow-auto px-5 py-5">
            <section className="rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4">
              <MultiSelector
                label="Formats"
                options={FORMAT_OPTIONS}
                value={[...form.formats]}
                onChange={(value) => setFormats(value as ExportFormat[])}
                triggerDisplay="labels"
                width="100%"
              />
            </section>

            <section className="rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4">
              <ResolutionPicker
                value={form.resolution}
                customWidth={form.customWidth}
                customHeight={form.customHeight}
                onChange={setResolution}
                onCustomSizeChange={setCustomSize}
              />
            </section>

            <section className="rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]">
                Frame treatment
              </div>
              <SegmentedControl
                label="Frame treatment"
                value={form.frameMode}
                onChange={(value) => setFrameMode(value as "source" | "framed")}
                layout="fill"
                className="mt-3"
              >
                {(["source", "framed"] as const).map((mode) => (
                  <SegmentedControlItem
                    key={mode}
                    value={mode}
                    label={mode === "source" ? "Source fill" : "Cinematic frame"}
                  />
                ))}
              </SegmentedControl>
              {form.frameMode === "framed" ? (
                <p className="font-serif mt-3 text-xs leading-5 text-[var(--color-text-secondary)]">
                  Cinematic frame adds padding around the recording. Use a higher resolution when
                  preserving native 1080p text detail matters.
                </p>
              ) : null}
            </section>

            <section className="rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]">
                Motion fidelity
              </div>
              <SegmentedControl
                label="Motion fidelity"
                value={String(form.fps)}
                onChange={(value) => setFps(Number(value))}
                layout="fill"
                className="mt-3"
              >
                {FPS_CHOICES.map((n) => (
                  <SegmentedControlItem key={n} value={String(n)} label={String(n)} />
                ))}
              </SegmentedControl>
            </section>

            <section className="rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4">
              <div className="grid gap-4">
                <div>
                  <label
                    htmlFor="export-quality"
                    className="block text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]"
                  >
                    Quality
                  </label>
                  <AstryxSelector
                    value={form.quality}
                    onChange={(value) => setQuality(value as "low" | "med" | "high")}
                    options={[
                      { value: "low", label: "Low" },
                      { value: "med", label: "Medium" },
                      { value: "high", label: "High" },
                    ]}
                    label="Export quality"
                    isLabelHidden
                    className="mt-3 min-h-12 rounded-2xl px-4 py-3 text-sm"
                  />
                </div>

                <div>
                  <label
                    htmlFor="export-basename"
                    className="block text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]"
                  >
                    Base file name
                  </label>
                  <AstryxTextInput
                    value={form.baseName}
                    onChange={setBaseName}
                    label="Export base file name"
                    isLabelHidden
                    width="100%"
                    className="mt-3"
                  />
                </div>

                <div>
                  <span className="block text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-disabled)]">
                    Output folder
                  </span>
                  <div className="mt-3 flex items-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-card)] p-2">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-disabled)]">
                      <FolderOpen className="h-4 w-4" />
                    </div>
                    <AstryxTextInput
                      value={form.outFolder ?? ""}
                      label="Output folder"
                      isLabelHidden
                      isDisabled
                      disabledMessage="Use Pick to choose the export folder"
                      placeholder="Pick a folder…"
                      width="100%"
                      className="min-w-0 flex-1"
                    />
                    <AstryxButton variant="secondary" size="sm" onClick={pickFolder} label="Pick">
                      Pick
                    </AstryxButton>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-4">
              <CollapsibleGroup type="single">
                <Collapsible value="advanced" trigger="Advanced options" defaultIsOpen={false}>
                  <AdvancedOutputOptions />
                </Collapsible>
              </CollapsibleGroup>
            </section>

            {!graphAvailable ? (
              <section className="rounded-[var(--radius-container)] border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/8 p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-xl border border-[var(--color-accent)]/20 bg-[var(--color-background-card)] p-2 text-[var(--color-accent)]">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-[var(--color-text-primary)]">
                      Nothing to export yet
                    </div>
                    <p className="font-serif mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">
                      Add a video clip with a source path to the timeline, then this drawer will
                      assemble the render graph automatically.
                    </p>
                  </div>
                </div>
              </section>
            ) : null}

            {preflightIssues.length > 0 ? (
              <div
                role="alert"
                className="rounded-[var(--radius-container)] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
              >
                <div className="flex items-center gap-2 font-medium">
                  <TriangleAlert className="h-4 w-4" />
                  Export preflight
                </div>
                <ul className="mt-3 list-inside list-disc space-y-1 text-xs text-amber-100/85">
                  {preflightIssues.map((issue) => (
                    <li key={issue.id}>
                      {issue.output_index != null ? `Output ${issue.output_index + 1} · ` : ""}
                      {issue.clip_id ? `Clip ${issue.clip_id} · ` : ""}
                      {issue.message}
                      {issue.remediation ? ` ${issue.remediation}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <footer className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-background-card)] px-5 py-4">
            <AstryxButton
              variant="ghost"
              size="sm"
              onClick={() => void runValidate()}
              label="Validate"
            >
              Validate
            </AstryxButton>
            <AstryxButton
              variant="primary"
              size="sm"
              isDisabled={!canSubmit}
              aria-disabled={!canSubmit}
              onClick={onSubmit}
              aria-label="Start export"
              tooltip={
                !graphAvailable ? "Add a video clip with a sourcePath to the timeline" : undefined
              }
              label="Start export"
            >
              {submitting ? "Queueing…" : "Export"}
            </AstryxButton>
          </footer>
        </div>
      </Dialog>
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
