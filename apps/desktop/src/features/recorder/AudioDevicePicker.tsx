/**
 * AudioDevicePicker — Phase 6 plan 01 (D-02 / D-04).
 *
 * Base UI Select with three classes of entries:
 *   1. "No audio"       → value = null (default selection every render)
 *   2. "System default" → value = "default" (host resolves cpal default)
 *   3. Enumerated devices — value = device name from listAudioInputs()
 *
 * Non-stickiness (D-02, D-19 pattern): the parent Zustand slice resets
 * this to null on recorder-view mount AND on recording completion. The
 * picker itself does NOT remember a prior choice — "No audio" is the
 * default value prop every render.
 *
 * Laziness: the listAudioInputs query is gated by an `open` handler on
 * the trigger. Querying at component mount would defeat the cpal#901
 * workaround (mic TCC prompt on cold launch).
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mic } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUDIO_DEFAULT_SENTINEL,
  listAudioInputs,
  type AudioInputInfo,
  type AudioPickerValue,
} from "@/ipc/audio";

interface AudioDevicePickerProps {
  /** Current selection. `null` = no audio. */
  value: AudioPickerValue;
  /** Called with the new selection. */
  onValueChange: (value: AudioPickerValue) => void;
  /** Disables the picker (e.g., during recording). */
  disabled?: boolean;
}

// Base UI Select requires a non-null value. We round-trip through a
// sentinel string so "No audio" (null) has a stable Select identity.
const NO_AUDIO_SENTINEL = "__no_audio__";

function encode(value: AudioPickerValue): string {
  return value == null ? NO_AUDIO_SENTINEL : value;
}

function decode(raw: string): AudioPickerValue {
  return raw === NO_AUDIO_SENTINEL ? null : raw;
}

export function AudioDevicePicker({
  value,
  onValueChange,
  disabled,
}: AudioDevicePickerProps) {
  const [hasOpened, setHasOpened] = useState(false);

  // Query fires ONLY once the picker opens. staleTime: 0 + never refetch
  // so we don't spam CoreAudio while the picker is held open.
  const {
    data: devices = [],
    isLoading,
  } = useQuery<AudioInputInfo[]>({
    queryKey: ["audio-inputs"],
    queryFn: listAudioInputs,
    enabled: hasOpened,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  return (
    <Select
      value={encode(value)}
      onValueChange={(raw) => {
        if (typeof raw === "string") onValueChange(decode(raw));
      }}
      onOpenChange={(open) => {
        if (open) setHasOpened(true);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="Microphone input device"
        className="flex w-full items-center gap-2"
      >
        <Mic
          size={13}
          className="shrink-0 text-[var(--color-fg-muted)]"
          aria-hidden="true"
        />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={NO_AUDIO_SENTINEL}>No audio</SelectItem>
          <SelectItem value={AUDIO_DEFAULT_SENTINEL}>System default</SelectItem>
        </SelectGroup>
        {hasOpened && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectGroupLabel>Input devices</SelectGroupLabel>
              {isLoading && (
                <SelectItem value="__loading__" disabled>
                  Loading…
                </SelectItem>
              )}
              {!isLoading && devices.length === 0 && (
                <SelectItem value="__empty__" disabled>
                  No microphones detected
                </SelectItem>
              )}
              {devices.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                  {d.is_default ? " (default)" : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
