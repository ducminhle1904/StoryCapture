/**
 * Astryx Selector wrapping the cpal device list. Laziness: listAudioInputs
 * fires on first focus/pointer intent — querying at mount trips cpal#901 (mic
 * TCC prompt on cold launch). Non-sticky: parent state resets to null
 * every render so "No audio" is always the default.
 */

import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { useQuery } from "@tanstack/react-query";
import { Mic } from "lucide-react";
import { useState } from "react";
import { type AudioInputInfo, type AudioPickerValue, listAudioInputs } from "@/ipc/audio";

interface AudioDevicePickerProps {
  /** Current selection. `null` = no audio. */
  value: AudioPickerValue;
  /** Called with the new selection. */
  onValueChange: (value: AudioPickerValue) => void;
  /** Disables the picker (e.g., during recording). */
  disabled?: boolean;
}

/**
 * Typed representation of what the selector is showing.
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

export function AudioDevicePicker({ value, onValueChange, disabled }: AudioDevicePickerProps) {
  const [hasOpened, setHasOpened] = useState(false);

  // Query fires ONLY once the picker opens. staleTime: 0 + never refetch
  // so we don't spam CoreAudio while the picker is held open.
  const { data: devices = [], isLoading } = useQuery<AudioInputInfo[]>({
    queryKey: ["audio-inputs"],
    queryFn: listAudioInputs,
    enabled: hasOpened,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  return (
    <AstryxSelector
      label="Microphone input device"
      isLabelHidden
      value={choiceToSelectValue(valueToChoice(value))}
      options={[
        {
          type: "section",
          options: [
            { value: choiceToSelectValue({ kind: "none" }), label: "No audio" },
            { value: choiceToSelectValue({ kind: "default" }), label: "System default" },
          ],
        },
        ...(hasOpened
          ? [
              {
                type: "section" as const,
                title: "Input devices",
                options: [
                  ...(isLoading
                    ? [
                        {
                          value: choiceToSelectValue({ kind: "loading" }),
                          label: "Loading…",
                          disabled: true,
                        },
                      ]
                    : []),
                  ...(!isLoading && devices.length === 0
                    ? [
                        {
                          value: choiceToSelectValue({ kind: "empty" }),
                          label: "No microphones detected",
                          disabled: true,
                        },
                      ]
                    : []),
                  ...devices.map((device) => ({
                    value: choiceToSelectValue({ kind: "device", id: device.id }),
                    label: `${device.name}${device.is_default ? " (default)" : ""}`,
                  })),
                ],
              },
            ]
          : []),
      ]}
      onChange={(raw) => {
        onValueChange(choiceToValue(selectValueToChoice(raw)));
      }}
      onFocus={() => setHasOpened(true)}
      onPointerDown={() => setHasOpened(true)}
      startIcon={<Mic size={13} aria-hidden="true" />}
      isDisabled={disabled}
      width="100%"
    />
  );
}
