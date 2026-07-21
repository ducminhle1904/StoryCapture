import { Button } from "@astryxdesign/core/Button";
import { Popover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import { forwardRef, useEffect, useState } from "react";

interface StoryColorFieldProps {
  value: string;
  onChange: (hex: string) => void;
  label?: string;
  disabled?: boolean;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export const StoryColorField = forwardRef<HTMLInputElement, StoryColorFieldProps>(
  ({ value, onChange, label = "Pad color", disabled }, ref) => {
    const [text, setText] = useState(value.toLowerCase());

    useEffect(() => setText(value.toLowerCase()), [value]);

    const commit = (nextValue: string) => {
      const normalized = nextValue.toLowerCase();
      setText(normalized);
      if (HEX_COLOR.test(normalized)) onChange(normalized);
    };

    const invalid = !HEX_COLOR.test(text);

    return (
      <div className="flex items-start gap-2">
        <Popover
          label={`${label} picker`}
          isEnabled={!disabled}
          content={
            <input
              type="color"
              value={HEX_COLOR.test(text) ? text : value}
              onChange={(event) => commit(event.currentTarget.value)}
              aria-label={`${label} picker`}
              className="h-24 w-40 cursor-pointer border-0 bg-transparent p-0"
            />
          }
        >
          <Button
            label={`Choose ${label.toLowerCase()}`}
            variant="secondary"
            size="sm"
            isDisabled={disabled}
            icon={
              <span
                aria-hidden="true"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "var(--radius-inner)",
                  border: "1px solid var(--color-border-emphasized)",
                  background: HEX_COLOR.test(text) ? text : value,
                }}
              />
            }
          />
        </Popover>
        <TextInput
          ref={ref}
          label={label}
          isLabelHidden
          value={text}
          onChange={commit}
          isDisabled={disabled}
          status={invalid ? { type: "error", message: "Use a six-digit hex color." } : undefined}
          width={112}
        />
      </div>
    );
  },
);

StoryColorField.displayName = "StoryColorField";
