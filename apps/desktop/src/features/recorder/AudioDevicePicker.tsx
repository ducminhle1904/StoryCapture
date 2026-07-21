/**
 * Base UI Select wrapping the cpal device list. Laziness: listAudioInputs
 * fires on the trigger's `open` — querying at mount trips cpal#901 (mic
 * TCC prompt on cold launch). Non-sticky: parent state resets to null
 * every render so "No audio" is always the default.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mic } from "lucide-react";

import {
  ScSelect as Select,
  ScSelectContent as SelectContent,
  ScSelectGroup as SelectGroup,
  ScSelectGroupLabel as SelectGroupLabel,
  ScSelectItem as SelectItem,
  ScSelectSeparator as SelectSeparator,
  ScSelectTrigger as SelectTrigger,
  ScSelectValue as SelectValue,
} from "@storycapture/ui";
import {
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

/**
 * Typed representation of what the Select is showing. The Base UI Select
 * requires a non-null string value, so we round-trip every choice through
 * a stable `kind:payload` string. Keeps magic strings out of the JSX.
 */
type AudioPickerChoice =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "device"; id: string }
  | { kind: "loading" }
  | { kind: "empty" };

function choiceToSelectValue(c: AudioPickerChoice): string {
  switch (c.kind) {
    case "none":
      return "none:";
    case "default":
      return "default:";
    case "device":
      return `device:${c.id}`;
    case "loading":
      return "loading:";
    case "empty":
      return "empty:";
  }
}

function selectValueToChoice(s: string): AudioPickerChoice {
  const idx = s.indexOf(":");
  const kind = idx === -1 ? s : s.slice(0, idx);
  const payload = idx === -1 ? "" : s.slice(idx + 1);
  switch (kind) {
    case "none":
      return { kind: "none" };
    case "default":
      return { kind: "default" };
    case "device":
      return { kind: "device", id: payload };
    case "loading":
      return { kind: "loading" };
    case "empty":
      return { kind: "empty" };
    default:
      // Unknown encoding → treat as "no audio" so the UI stays consistent.
      return { kind: "none" };
  }
}

function valueToChoice(value: AudioPickerValue): AudioPickerChoice {
  if (value == null) return { kind: "none" };
  if (value === "default") return { kind: "default" };
  return { kind: "device", id: value };
}

function choiceToValue(c: AudioPickerChoice): AudioPickerValue {
  switch (c.kind) {
    case "none":
      return null;
    case "default":
      return "default";
    case "device":
      return c.id;
    // The sentinels below are never selectable (disabled items), but if
    // one ever leaks through, fall back to "no audio" rather than
    // assigning a garbage device id.
    case "loading":
    case "empty":
      return null;
  }
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
      value={choiceToSelectValue(valueToChoice(value))}
      onValueChange={(raw) => {
        if (typeof raw !== "string") return;
        onValueChange(choiceToValue(selectValueToChoice(raw)));
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
          <SelectItem value={choiceToSelectValue({ kind: "none" })}>
            No audio
          </SelectItem>
          <SelectItem value={choiceToSelectValue({ kind: "default" })}>
            System default
          </SelectItem>
        </SelectGroup>
        {hasOpened && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectGroupLabel>Input devices</SelectGroupLabel>
              {isLoading && (
                <SelectItem
                  value={choiceToSelectValue({ kind: "loading" })}
                  disabled
                >
                  Loading…
                </SelectItem>
              )}
              {!isLoading && devices.length === 0 && (
                <SelectItem
                  value={choiceToSelectValue({ kind: "empty" })}
                  disabled
                >
                  No microphones detected
                </SelectItem>
              )}
              {devices.map((d) => (
                <SelectItem
                  key={d.id}
                  value={choiceToSelectValue({ kind: "device", id: d.id })}
                >
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
