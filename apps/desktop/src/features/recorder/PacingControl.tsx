import { ScSegmented } from "@storycapture/ui";

import { type RecordingPacingProfile, useOutputPrefsStore } from "@/state/output-prefs";

import { LABEL_PACING, PACING_OPTION_LABELS } from "./video-output/copy";

const PACING_VALUES = ["raw", "fast", "normal", "cinematic"] as const;
const PACING_OPTIONS = PACING_VALUES.map((value) => ({
  value,
  label: PACING_OPTION_LABELS[value],
}));

interface Props {
  disabled?: boolean;
}

export function PacingControl({ disabled }: Props) {
  const pacing = useOutputPrefsStore((s) => s.recordingPacing);
  const setPacing = useOutputPrefsStore((s) => s.setRecordingPacing);

  return (
    <div className="space-y-1.5">
      <span className="block text-xs text-[var(--color-fg-muted)]">{LABEL_PACING}</span>
      <ScSegmented
        value={pacing}
        onValueChange={(value) => {
          if (isRecordingPacingProfile(value)) setPacing(value);
        }}
        options={PACING_OPTIONS}
        size="sm"
        disabled={disabled}
        aria-label="Recording pacing"
        className="w-full"
      />
    </div>
  );
}

function isRecordingPacingProfile(value: string): value is RecordingPacingProfile {
  return (PACING_VALUES as readonly string[]).includes(value);
}
