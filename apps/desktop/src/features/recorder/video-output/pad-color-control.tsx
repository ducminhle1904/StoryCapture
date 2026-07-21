/**
 * Pad-color knob. ToggleGroup over {black, white, custom}; Custom reveals
 * a ColorField. hex↔rgb helpers are colocated pure functions — kept out
 * of bitrate.ts.
 */

import type { PadColorDto } from "@storycapture/shared-types";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { ColorField } from "@/components/ui/color-field";
import { ScToggleGroup as ToggleGroup, ScToggleGroupItem as ToggleGroupItem } from "@storycapture/ui";
import { useOutputPrefsStore } from "@/state/output-prefs";

import { LABEL_PAD, PAD_OPTION_LABELS } from "./copy";

const ORDER: PadColorDto["kind"][] = ["black", "white", "custom"];

function hexFromRgb(r: number, g: number, b: number): string {
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbFromHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

function padToHex(pad: PadColorDto): string {
  switch (pad.kind) {
    case "black":
      return "#000000";
    case "white":
      return "#ffffff";
    case "custom":
      return hexFromRgb(pad.r, pad.g, pad.b);
  }
}

interface Props {
  disabled?: boolean;
}

export function PadColorControl({ disabled }: Props) {
  const pad = useOutputPrefsStore((s) => s.recordingKnobs.pad);
  const setKnob = useOutputPrefsStore((s) => s.setRecordingKnob);
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        aria-label={LABEL_PAD}
        value={[pad.kind]}
        onValueChange={(next) => {
          const v = next[0];
          if (v === "black") setKnob("pad", { kind: "black" });
          else if (v === "white") setKnob("pad", { kind: "white" });
          else if (v === "custom") {
            const hex = padToHex(pad);
            const { r, g, b } = rgbFromHex(hex);
            setKnob("pad", { kind: "custom", r, g, b });
          }
        }}
        disabled={disabled}
      >
        {ORDER.map((k) => (
          <ToggleGroupItem key={k} value={k}>
            {PAD_OPTION_LABELS[k]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <AnimatePresence initial={false}>
        {pad.kind === "custom" && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden"
          >
            <ColorField
              value={padToHex(pad)}
              onChange={(hex) => {
                const { r, g, b } = rgbFromHex(hex);
                if ([r, g, b].every(Number.isFinite)) {
                  setKnob("pad", { kind: "custom", r, g, b });
                }
              }}
              disabled={disabled}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
