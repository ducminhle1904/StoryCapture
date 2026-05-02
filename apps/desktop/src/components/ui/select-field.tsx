import {
  ScSelect,
  ScSelectContent,
  ScSelectItem,
  ScSelectTrigger,
  ScSelectValue,
} from "@storycapture/ui";
import { cn } from "@/lib/utils";

export interface SelectFieldOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectFieldProps {
  value: string;
  options: readonly SelectFieldOption[];
  onValueChange: (value: string) => void;
  "aria-label": string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}

export function SelectField({
  value,
  options,
  onValueChange,
  className,
  disabled,
  placeholder,
  autoFocus,
  "aria-label": ariaLabel,
}: SelectFieldProps) {
  const selected = options.find((option) => option.value === value);

  return (
    <ScSelect
      value={value}
      onValueChange={(next) => onValueChange(String(next))}
      disabled={disabled}
    >
      <ScSelectTrigger
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={cn("w-full min-w-0", className)}
      >
        <ScSelectValue>{selected?.label ?? placeholder ?? value}</ScSelectValue>
      </ScSelectTrigger>
      <ScSelectContent>
        {placeholder ? (
          <ScSelectItem value="" disabled>
            {placeholder}
          </ScSelectItem>
        ) : null}
        {options.map((option) => (
          <ScSelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </ScSelectItem>
        ))}
      </ScSelectContent>
    </ScSelect>
  );
}
