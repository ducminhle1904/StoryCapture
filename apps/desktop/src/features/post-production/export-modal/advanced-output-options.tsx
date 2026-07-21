/**
 * AdvancedOutputOptions — 8 export-only knobs grouped into 3 visual
 * sub-groups. Conditional fields per encoder via deriveQualityControls().
 * HW encoder list = probe + Software fallback.
 */

import { Field } from "@astryxdesign/core/Field";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Slider } from "@astryxdesign/core/Slider";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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
      className={`grid gap-3 border-t border-[var(--color-border)] pt-4 mt-4 first:border-t-0 first:pt-0 first:mt-0 ${className ?? ""}`}
    >
      <div className="text-[13px] font-medium uppercase tracking-wide text-[var(--color-text-secondary)] mb-2">
        {label}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-6 md:gap-y-4">{children}</div>
    </section>
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
        <Selector
          label={copy.LABEL_CONTAINER}
          value={exportKnobs.container}
          options={[
            { value: "mp4", label: "MP4" },
            { value: "webm", label: "WebM (not yet supported)", disabled: true },
          ]}
          onChange={(value) => setExportKnob("container", value as ExportContainer)}
        />
        <Selector
          label={copy.LABEL_CODEC}
          value={exportKnobs.codec}
          options={[{ value: "h264", label: "H.264" }]}
          onChange={() => {}}
          isDisabled
        />
      </SubGroup>

      <SubGroup label={copy.LABEL_GROUP_ENCODER_QUALITY}>
        <Selector
          label={copy.LABEL_HW_ENCODER}
          value={exportKnobs.hwEncoder}
          options={[
            { value: "auto", label: UI_LABEL.auto },
            ...displayedEncoders.map((encoder) => ({ value: encoder, label: UI_LABEL[encoder] })),
            {
              value: exportKnobs.hwEncoder === "libx264" ? "libx264" : "software",
              label: UI_LABEL.software,
            },
            ...(hwUnavailable
              ? [
                  {
                    value: exportKnobs.hwEncoder,
                    label: `${exportKnobs.hwEncoder} ${copy.SUFFIX_HW_UNAVAILABLE}`,
                    disabled: true,
                  },
                ]
              : []),
          ]}
          onChange={onHwEncoderChange}
        />
        {hwUnavailable ? (
          <output
            aria-live="polite"
            data-testid="hw-encoder-warning"
            className="text-xs text-[var(--color-warning,var(--color-accent))]"
          >
            {copy.WARN_HW_UNAVAILABLE(exportKnobs.hwEncoder)}
          </output>
        ) : null}
        {quality.qualityControl.kind === "auto-hide" ? (
          <div className="text-xs text-[var(--color-text-secondary)]">
            {quality.qualityControl.note}
          </div>
        ) : (
          <>
            {quality.rateControlOptions.length > 0 ? (
              <RadioList
                label={copy.LABEL_RATE_CONTROL}
                value={exportKnobs.rateControl}
                onChange={(value) => setExportKnob("rateControl", value as ExportRateControl)}
                orientation="horizontal"
                size="sm"
              >
                {quality.rateControlOptions.map((opt) => (
                  <RadioListItem
                    key={opt.value}
                    value={opt.value}
                    label={opt.value.toUpperCase()}
                    isDisabled={opt.locked}
                  />
                ))}
              </RadioList>
            ) : null}
            {quality.qualityControl.kind === "slider-crf" ||
            quality.qualityControl.kind === "slider-cq" ? (
              <Slider
                label={copy.LABEL_QUALITY_SLIDER}
                min={quality.qualityControl.min}
                max={quality.qualityControl.max}
                value={qualityValue}
                onChange={(value: number) => setExportKnob("qualityValue", value)}
              />
            ) : quality.qualityControl.kind === "number-bitrate-mbps" ? (
              <NumberInput
                label={copy.LABEL_BITRATE_MBPS}
                min={quality.qualityControl.min}
                max={quality.qualityControl.max}
                value={qualityValue}
                onChange={(value) => setExportKnob("qualityValue", value)}
              />
            ) : null}
            {quality.presetOptions.length > 0 ? (
              <Selector
                label={copy.LABEL_PRESET}
                value={exportKnobs.encoderPreset}
                options={quality.presetOptions.map((preset) => ({
                  value: preset,
                  label: preset,
                }))}
                onChange={(value) => setExportKnob("encoderPreset", value as ExportEncoderPreset)}
              />
            ) : null}
            {quality.note ? (
              <div className="text-xs text-[var(--color-text-secondary)]">{quality.note}</div>
            ) : null}
          </>
        )}
      </SubGroup>

      <SubGroup label={copy.LABEL_GROUP_KEYFRAME_AUDIO} className="md:col-span-2">
        <NumberInput
          label={copy.LABEL_KEYFRAME}
          min={1}
          max={10}
          value={exportKnobs.keyframeSec}
          onChange={(value) => setExportKnob("keyframeSec", value)}
        />
        <RadioList
          label={copy.LABEL_DOWNSCALE}
          value={exportKnobs.resamplingQuality}
          onChange={(value) => setExportKnob("resamplingQuality", value as ExportResamplingQuality)}
          orientation="horizontal"
          size="sm"
        >
          {(["high", "balanced", "fast"] as const).map((opt) => (
            <RadioListItem key={opt} value={opt} label={opt} />
          ))}
        </RadioList>
        <Field label={copy.LABEL_AUDIO_CODEC} inputID="export-audio-codec">
          <output id="export-audio-codec" className="text-xs text-[var(--color-text-secondary)]">
            AAC-LC
          </output>
        </Field>
        <Field label={copy.LABEL_AUDIO_BITRATE} inputID="export-audio-bitrate">
          <output
            id="export-audio-bitrate"
            className="text-xs tabular-nums text-[var(--color-text-secondary)]"
          >
            192 kbps
          </output>
        </Field>
        <Field label={copy.LABEL_AUDIO_CHANNELS} inputID="export-audio-channels">
          <output id="export-audio-channels" className="text-xs text-[var(--color-text-secondary)]">
            Stereo · 48 kHz
          </output>
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
