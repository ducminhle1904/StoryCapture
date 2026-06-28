/**
 * Select primitive — shadcn-style chrome on top of Base UI's Select.
 *
 * Exported subcomponents mirror shadcn's naming (Trigger / Value / Content /
 * Item). Enter/exit animations ride Base UI's `data-[starting-style]` +
 * `data-[ending-style]` attributes (same pattern as `dialog-motion.ts`).
 */

import { Select as BaseSelect } from "@base-ui/react/select";
import { Check } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Select = BaseSelect.Root;
export const SelectValue = BaseSelect.Value;

function SelectChevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 transition-transform duration-150 group-data-[popup-open]:rotate-180"
    >
      <path d="M4.25 6.25 8 10l3.75-3.75" />
    </svg>
  );
}

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof BaseSelect.Trigger>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Trigger
    ref={ref}
    className={cn(
      "group inline-flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2.5 py-1.5 text-xs text-[var(--color-fg-primary)] transition-colors",
      "shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_1px_1px_rgba(0,0,0,0.18)]",
      "hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-300)]",
      "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[popup-open]:bg-[var(--color-surface-300)]",
      "active:translate-y-px",
      className,
    )}
    {...props}
  >
    {children}
    <BaseSelect.Icon className="text-[var(--color-fg-muted)]">
      <SelectChevron />
    </BaseSelect.Icon>
  </BaseSelect.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof BaseSelect.Popup>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Popup>
>(({ className, children, style, ...props }, ref) => (
  <BaseSelect.Portal>
    <BaseSelect.Positioner sideOffset={7} className="z-50 outline-none">
      <BaseSelect.Popup
        ref={ref}
        className={cn(
          // chrome
          "max-h-[min(var(--available-height),20rem)] min-w-[var(--anchor-width)] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] p-1.5 text-xs text-[var(--color-fg-primary)] shadow-[0_18px_42px_rgba(0,0,0,0.34),0_3px_10px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.06)]",
          // enter/exit
          "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
          "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]",
          "data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:duration-100",
          className,
        )}
        style={{
          backgroundColor: "var(--sc-surface)",
          backgroundImage:
            "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.018) 34%, rgba(255,255,255,0) 100%)",
          ...style,
        }}
        {...props}
      >
        {children}
      </BaseSelect.Popup>
    </BaseSelect.Positioner>
  </BaseSelect.Portal>
));
SelectContent.displayName = "SelectContent";

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof BaseSelect.Item>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Item>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Item
    ref={ref}
    className={cn(
      "relative flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-[calc(var(--radius-md)-1px)] py-1.5 pl-7 pr-2.5 text-xs text-[var(--color-fg-secondary)] outline-none transition-[background,color,transform] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
      "data-[highlighted]:bg-[linear-gradient(90deg,color-mix(in_oklch,var(--color-accent-primary)_18%,transparent),transparent_74%),var(--color-surface-300)] data-[highlighted]:text-[var(--color-fg-primary)]",
      "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
      "active:translate-y-px",
      className,
    )}
    {...props}
  >
    <span className="absolute left-1.5 flex h-3 w-3 items-center justify-center">
      <BaseSelect.ItemIndicator>
        <Check size={11} className="text-[var(--color-accent-primary)]" aria-hidden="true" />
      </BaseSelect.ItemIndicator>
    </span>
    <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
  </BaseSelect.Item>
));
SelectItem.displayName = "SelectItem";

// Grouping primitives — optional helpers used by TargetPicker.
// Base UI's Select supports semantic grouping via Group / GroupLabel.
export const SelectGroup = BaseSelect.Group;

export const SelectGroupLabel = React.forwardRef<
  React.ElementRef<typeof BaseSelect.GroupLabel>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.GroupLabel>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.GroupLabel
    ref={ref}
    className={cn(
      "px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]",
      className,
    )}
    {...props}
  >
    {children}
  </BaseSelect.GroupLabel>
));
SelectGroupLabel.displayName = "SelectGroupLabel";

export const SelectSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    role="separator"
    className={cn("my-1 h-px bg-[var(--color-border-subtle)]", className)}
    {...props}
  />
));
SelectSeparator.displayName = "SelectSeparator";
