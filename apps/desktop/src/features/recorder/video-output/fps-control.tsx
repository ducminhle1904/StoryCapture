/**
 * FPS knob — 24 / 30 / 60 options as a horizontal Astryx RadioList.
 */

import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { useOutputPrefsStore } from "@/state/output-prefs";
import { LABEL_FPS } from "./copy";

const OPTIONS = [24, 30, 60] as const;

interface Props {
  disabled?: boolean;
}

export function FpsControl({ disabled }: Props) {
  const fps = useOutputPrefsStore((s) => s.recordingKnobs.fps);
  const setKnob = useOutputPrefsStore((s) => s.setRecordingKnob);

  return (
    <RadioList
      label={LABEL_FPS}
      isLabelHidden
      value={String(fps)}
      onChange={(raw) => {
        const n = Number(raw);
        if (Number.isFinite(n)) setKnob("fps", n);
      }}
      isDisabled={disabled}
      orientation="horizontal"
      size="sm"
    >
      {OPTIONS.map((fpsOption) => (
        <RadioListItem key={fpsOption} value={String(fpsOption)} label={String(fpsOption)} />
      ))}
    </RadioList>
  );
}
