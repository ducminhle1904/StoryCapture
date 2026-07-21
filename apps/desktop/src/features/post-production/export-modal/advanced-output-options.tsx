/**
 * AdvancedOutputOptions — 8 export-only knobs grouped into 3 visual
 * sub-groups. Conditional fields per encoder via deriveQualityControls().
 * HW encoder list = probe + Software fallback.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { NumberField } from "@/components/ui/number-field";
import { ScRadioGroup as RadioGroup, ScRadioGroupItem as RadioGroupItem } from "@storycapture/ui";
import {
  ScSelect as Select,
  ScSelectContent as SelectContent,
  ScSelectItem as SelectItem,
  ScSelectTrigger as SelectTrigger,
  ScSelectValue as SelectValue,
} from "@storycapture/ui";
import { ScSlider as Slider } from "@storycapture/ui";
import { probeHwEncoders } from "@/ipc/encode";
import {
  type ExportContainer,
  type ExportEncoderPreset,
  type ExportRateControl,
  type ExportResamplingQuality,
  useOutputPrefsStore,
} from "@/state/output-prefs";

import * as copy from "./advanced-copy";
import { deriveQualityControls, type QualityControlSpec } from "./encoder-options-table";

type HwEncoderKind =
  | "auto"
  | "software"
  | "libx264"
  | "h264-videotoolbox"
  | "h264-nvenc"
  | "h264-qsv"
  | "h264-amf"
  | "libopenh264";

/** Serialized HardwareEncoderDto -> UI kebab identifier. */
const PROBE_TO_UI: Record<string, HwEncoderKind> = {
  "video-toolbox-h264": "h264-videotoolbox",
  "nvenc-h264": "h264-nvenc",
  "qsv-h264": "h264-qsv",
  "amf-h264": "h264-amf",
  "libx264-software": "libx264",
  "openh-264-software": "libopenh264",
};

const UI_LABEL: Record<HwEncoderKind, string> = {
  auto: "Auto",
  software: "Software (libx264)",
  libx264: "Software (libx264)",
  "h264-videotoolbox": "VideoToolbox H.264",
  "h264-nvenc": "NVENC H.264",
  "h264-qsv": "QuickSync H.264",
  "h264-amf": "AMF H.264",
  libopenh264: "OpenH264 (fallback)",
};

interface ProbeShape {
  available?: unknown;
  preferred?: unknown;
}

function parseProbe(raw: unknown): HwEncoderKind[] {
  if (!raw || typeof raw !== "object") return [];
  const probe = raw as ProbeShape;
  const list = Array.isArray(probe.available) ? probe.available : [];
  const out: HwEncoderKind[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && PROBE_TO_UI[entry]) {
      out.push(PROBE_TO_UI[entry]);
    }
  }
  return out;
}

function SubGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`grid gap-3 border-t border-[var(--color-border-subtle)] pt-4 mt-4 first:border-t-0 first:pt-0 first:mt-0 ${className ?? ""}`}
    >
      <div className="text-[13px] font-medium uppercase tracking-wide text-[var(--color-fg-secondary)] mb-2">
        {label}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-6 md:gap-y-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
        {label}
      </span>
      {children}
    </div>
  );
}

export function AdvancedOutputOptions() {
  const exportKnobs = useOutputPrefsStore((s) => s.exportKnobs);
  const setExportKnob = useOutputPrefsStore((s) => s.setExportKnob);

  const { data: probeRaw } = useQuery({
    queryKey: ["hw-encoders"],
    queryFn: probeHwEncoders,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const availableEncoders = useMemo(() => parseProbe(probeRaw), [probeRaw]);
  const displayedEncoders = useMemo(
    () => availableEncoders.filter((encoder) => encoder !== "libx264" && encoder !== "libopenh264"),
    [availableEncoders],
  );

  const isSoftwareOrAuto =
    exportKnobs.hwEncoder === "auto" ||
    exportKnobs.hwEncoder === "software" ||
    exportKnobs.hwEncoder === "libx264";
  const hwUnavailable =
    !isSoftwareOrAuto && !availableEncoders.find((e) => e === exportKnobs.hwEncoder);

  const quality = deriveQualityControls(exportKnobs.hwEncoder, exportKnobs.codec);
  const qualityValue = exportKnobs.qualityValue ?? qualityDefault(quality.qualityControl);

  const onHwEncoderChange = (v: string) => {
    const defaults = deriveQualityControls(v, exportKnobs.codec);
    useOutputPrefsStore.setState((s) => ({
      exportKnobs: {
        ...s.exportKnobs,
        hwEncoder: v,
        rateControl: defaults.defaultRateControl,
        qualityValue: defaults.defaultQualityValue,
        encoderPreset: defaults.defaultPreset ?? "medium",
      },
    }));
  };

  return (
    <div className="grid gap-4">
      <SubGroup label={copy.LABEL_GROUP_CONTAINER_CODEC}>
        <Field label={copy.LABEL_CONTAINER}>
          <Select
            value={exportKnobs.container}
            onValueChange={(v) => {
              if (typeof v === "string") setExportKnob("container", v as ExportContainer);
            }}
          >
            <SelectTrigger aria-label={copy.LABEL_CONTAINER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mp4">MP4</SelectItem>
              <SelectItem value="webm" disabled>
                WebM (not yet supported)
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={copy.LABEL_CODEC}>
          <Select value={exportKnobs.codec} onValueChange={() => {}}>
            <SelectTrigger aria-label={copy.LABEL_CODEC}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="h264">H.264</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </SubGroup>

      <SubGroup label={copy.LABEL_GROUP_ENCODER_QUALITY}>
        <Field label={copy.LABEL_HW_ENCODER}>
          <Select
            value={exportKnobs.hwEncoder}
            onValueChange={(v) => {
              if (typeof v === "string") onHwEncoderChange(v);
            }}
          >
            <SelectTrigger aria-label={copy.LABEL_HW_ENCODER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{UI_LABEL.auto}</SelectItem>
              {displayedEncoders.map((e) => (
                <SelectItem key={e} value={e}>
                  {UI_LABEL[e]}
                </SelectItem>
              ))}
              <SelectItem value={exportKnobs.hwEncoder === "libx264" ? "libx264" : "software"}>
                {UI_LABEL.software}
              </SelectItem>
              {hwUnavailable ? (
                <SelectItem value={exportKnobs.hwEncoder} disabled>
                  {exportKnobs.hwEncoder} {copy.SUFFIX_HW_UNAVAILABLE}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </Field>
        {hwUnavailable ? (
          <output
            aria-live="polite"
            className="text-xs text-[var(--color-warning,var(--color-accent-primary))]"
          >
            {copy.WARN_HW_UNAVAILABLE(exportKnobs.hwEncoder)}
          </output>
        ) : null}
        {quality.qualityControl.kind === "auto-hide" ? (
          <div className="text-xs text-[var(--color-fg-muted)]">{quality.qualityControl.note}</div>
        ) : (
          <>
            {quality.rateControlOptions.length > 0 ? (
              <Field label={copy.LABEL_RATE_CONTROL}>
                <RadioGroup
                  value={exportKnobs.rateControl}
                  onValueChange={(v) => {
                    if (typeof v === "string") setExportKnob("rateControl", v as ExportRateControl);
                  }}
                  className="flex flex-wrap gap-4"
                >
                  {quality.rateControlOptions.map((opt) => (
                    <span
                      key={opt.value}
                      className="flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]"
                    >
                      <RadioGroupItem value={opt.value} disabled={opt.locked} />
                      {opt.value.toUpperCase()}
                    </span>
                  ))}
                </RadioGroup>
              </Field>
            ) : null}
            {quality.qualityControl.kind === "slider-crf" ||
            quality.qualityControl.kind === "slider-cq" ? (
              <Field label={copy.LABEL_QUALITY_SLIDER}>
                <Slider
                  min={quality.qualityControl.min}
                  max={quality.qualityControl.max}
                  value={qualityValue}
                  onValueChange={(v) => {
                    if (typeof v === "number") setExportKnob("qualityValue", v);
                  }}
                />
              </Field>
            ) : quality.qualityControl.kind === "number-bitrate-mbps" ? (
              <Field label={copy.LABEL_BITRATE_MBPS}>
                <NumberField
                  min={quality.qualityControl.min}
                  max={quality.qualityControl.max}
                  value={qualityValue}
                  onChange={(n) => setExportKnob("qualityValue", typeof n === "number" ? n : null)}
                />
              </Field>
            ) : null}
            {quality.presetOptions.length > 0 ? (
              <Field label={copy.LABEL_PRESET}>
                <Select
                  value={exportKnobs.encoderPreset}
                  onValueChange={(v) => {
                    if (typeof v === "string")
                      setExportKnob("encoderPreset", v as ExportEncoderPreset);
                  }}
                >
                  <SelectTrigger aria-label={copy.LABEL_PRESET}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {quality.presetOptions.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {quality.note ? (
              <div className="text-xs text-[var(--color-fg-muted)]">{quality.note}</div>
            ) : null}
          </>
        )}
      </SubGroup>

      <SubGroup label={copy.LABEL_GROUP_KEYFRAME_AUDIO} className="md:col-span-2">
        <Field label={copy.LABEL_KEYFRAME}>
          <NumberField
            min={1}
            max={10}
            value={exportKnobs.keyframeSec}
            onChange={(n) => setExportKnob("keyframeSec", typeof n === "number" ? n : 2)}
          />
        </Field>
        <Field label={copy.LABEL_DOWNSCALE}>
          <RadioGroup
            value={exportKnobs.resamplingQuality}
            onValueChange={(v) => {
              if (typeof v === "string")
                setExportKnob("resamplingQuality", v as ExportResamplingQuality);
            }}
            className="flex flex-wrap gap-4"
          >
            {(["high", "balanced", "fast"] as const).map((opt) => (
              <span
                key={opt}
                className="flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]"
              >
                <RadioGroupItem value={opt} />
                {opt}
              </span>
            ))}
          </RadioGroup>
        </Field>
        <Field label={copy.LABEL_AUDIO_CODEC}>
          <p className="text-xs text-[var(--color-fg-secondary)]">AAC-LC</p>
        </Field>
        <Field label={copy.LABEL_AUDIO_BITRATE}>
          <p className="text-xs tabular-nums text-[var(--color-fg-secondary)]">192 kbps</p>
        </Field>
        <Field label={copy.LABEL_AUDIO_CHANNELS}>
          <p className="text-xs text-[var(--color-fg-secondary)]">Stereo · 48 kHz</p>
        </Field>
      </SubGroup>
    </div>
  );
}

function qualityDefault(spec: QualityControlSpec): number {
  switch (spec.kind) {
    case "slider-crf":
    case "slider-cq":
    case "number-bitrate-mbps":
      return spec.default;
    default:
      return 0;
  }
}
