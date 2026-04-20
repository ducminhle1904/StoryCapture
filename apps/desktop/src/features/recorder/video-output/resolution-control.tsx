/**
 * Phase 13 D-13-08 resolution control.
 * Select with 6 options. Custom kind reveals W/H NumberFields + validation.
 * Lifts customDimsError to parent via onErrorChange so VideoOutputSection
 * can block the Record button on hard errors.
 */

import type { OutputResolutionDto } from "@storycapture/shared-types";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";

import { NumberField } from "@/components/ui/number-field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOutputPrefsStore } from "@/state/output-prefs";

import { type ValidationResult, validateCustomDims } from "./bitrate";
import {
  HELPER_CUSTOM_DIMS,
  LABEL_CUSTOM_H,
  LABEL_CUSTOM_W,
  LABEL_RESOLUTION,
  RESOLUTION_OPTION_LABELS,
  WARN_HARD_CUSTOM_DIMS,
} from "./copy";

type ResKind = OutputResolutionDto["kind"];

const KIND_OPTIONS: ResKind[] = ["p720", "p1080", "p1440", "p2160", "match-source", "custom"];

function kindOf(res: OutputResolutionDto): ResKind {
  return res.kind;
}

interface Props {
  disabled?: boolean;
  onErrorChange?: (err: (ValidationResult & { valid: false }) | null) => void;
}

export function ResolutionControl({ disabled, onErrorChange }: Props) {
  const resolution = useOutputPrefsStore((s) => s.recordingKnobs.resolution);
  const setKnob = useOutputPrefsStore((s) => s.setRecordingKnob);
  const reduceMotion = useReducedMotion();
  const errorId = useId();

  const isCustom = resolution.kind === "custom";
  const [wRaw, setWRaw] = useState<number | "">(isCustom ? resolution.w : 1280);
  const [hRaw, setHRaw] = useState<number | "">(isCustom ? resolution.h : 720);

  useEffect(() => {
    if (!isCustom) {
      onErrorChange?.(null);
      return;
    }
    const w = typeof wRaw === "number" ? wRaw : 0;
    const h = typeof hRaw === "number" ? hRaw : 0;
    const res = validateCustomDims(w, h);
    if (!res.valid) {
      onErrorChange?.(res);
    } else {
      onErrorChange?.(null);
      if (resolution.kind !== "custom" || resolution.w !== w || resolution.h !== h) {
        setKnob("resolution", { kind: "custom", w, h });
      }
    }
  }, [isCustom, wRaw, hRaw, resolution, setKnob, onErrorChange]);

  const w = typeof wRaw === "number" ? wRaw : 0;
  const h = typeof hRaw === "number" ? hRaw : 0;
  const validation = isCustom ? validateCustomDims(w, h) : { valid: true as const };
  const invalid = !validation.valid;

  return (
    <div className="flex flex-col gap-2">
      <Select
        value={kindOf(resolution)}
        onValueChange={(raw) => {
          if (typeof raw !== "string") return;
          const k = raw as ResKind;
          if (k === "custom") {
            const cw = typeof wRaw === "number" ? wRaw : 1280;
            const ch = typeof hRaw === "number" ? hRaw : 720;
            setKnob("resolution", { kind: "custom", w: cw, h: ch });
          } else if (k === "match-source") {
            setKnob("resolution", { kind: "match-source" });
          } else {
            setKnob("resolution", { kind: k } as OutputResolutionDto);
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger aria-label={LABEL_RESOLUTION} className="w-full">
          <SelectValue>{RESOLUTION_OPTION_LABELS[kindOf(resolution)]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {KIND_OPTIONS.map((k) => (
              <SelectItem key={k} value={k}>
                {RESOLUTION_OPTION_LABELS[k]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <AnimatePresence initial={false}>
        {isCustom && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-[var(--color-fg-muted)]">
                <label htmlFor={`${errorId}-w`}>{LABEL_CUSTOM_W}</label>
                <NumberField
                  id={`${errorId}-w`}
                  value={wRaw}
                  onChange={setWRaw}
                  min={16}
                  max={7680}
                  step={2}
                  invalid={invalid}
                  errorId={errorId}
                  disabled={disabled}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-[var(--color-fg-muted)]">
                <label htmlFor={`${errorId}-h`}>{LABEL_CUSTOM_H}</label>
                <NumberField
                  id={`${errorId}-h`}
                  value={hRaw}
                  onChange={setHRaw}
                  min={16}
                  max={4320}
                  step={2}
                  invalid={invalid}
                  errorId={errorId}
                  disabled={disabled}
                />
              </div>
            </div>
            <p className="mt-1 text-[10px] text-[var(--color-fg-muted)]">{HELPER_CUSTOM_DIMS}</p>
            {invalid && (
              <p id={errorId} className="mt-1 text-[11px] text-[var(--color-danger)]" role="alert">
                {WARN_HARD_CUSTOM_DIMS}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
