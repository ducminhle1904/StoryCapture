/**
 * Select primitive — shadcn-style chrome on top of Base UI's Select.
 *
 * Follows the project's D-32 constraint: Base UI, not Radix. The exported
 * subcomponents mirror shadcn's naming (Trigger / Value / Content / Item)
 * so call sites read familiar.
 *
 * Enter/exit animations ride Base UI's `data-[starting-style]` +
 * `data-[ending-style]` attributes — same pattern as `dialog-motion.ts`.
 */

import * as React from "react";
import { Select as BaseSelect } from "@base-ui-components/react/select";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export const Select = BaseSelect.Root;
export const SelectValue = BaseSelect.Value;

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof BaseSelect.Trigger>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Trigger
    ref={ref}
    className={cn(
      "inline-flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2.5 py-1.5 text-xs text-[var(--color-fg-primary)] transition-colors",
      "hover:bg-[var(--color-surface-300)]",
      "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[popup-open]:bg-[var(--color-surface-300)]",
      className,
    )}
    {...props}
  >
    {children}
    <BaseSelect.Icon className="text-[var(--color-fg-muted)]">
      <ChevronDown
        size={13}
        aria-hidden="true"
        className="transition-transform duration-150"
      />
    </BaseSelect.Icon>
  </BaseSelect.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof BaseSelect.Popup>,
  React.ComponentPropsWithoutRef<typeof BaseSelect.Popup>
>(({ className, children, ...props }, ref) => (
  <BaseSelect.Portal>
    <BaseSelect.Positioner sideOffset={4} className="z-50 outline-none">
      <BaseSelect.Popup
        ref={ref}
        className={cn(
          // chrome
          "max-h-[min(var(--available-height),20rem)] min-w-[var(--anchor-width)] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-1 text-xs text-[var(--color-fg-primary)] shadow-[var(--shadow-card)]",
          // enter/exit
          "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
          "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]",
          "data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:duration-100",
          className,
        )}
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
      "relative flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] py-1.5 pl-6 pr-2 text-xs text-[var(--color-fg-secondary)] outline-none transition-colors",
      "data-[highlighted]:bg-[var(--color-surface-300)] data-[highlighted]:text-[var(--color-fg-primary)]",
      "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-1.5 flex h-3 w-3 items-center justify-center">
      <BaseSelect.ItemIndicator>
        <Check
          size={11}
          className="text-[var(--color-accent-primary)]"
          aria-hidden="true"
        />
      </BaseSelect.ItemIndicator>
    </span>
    <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
  </BaseSelect.Item>
));
SelectItem.displayName = "SelectItem";

// Grouping primitives — optional helpers used by TargetPicker (Plan 05-01).
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
    className={cn(
      "my-1 h-px bg-[var(--color-border-subtle)]",
      className,
    )}
    {...props}
  />
));
SelectSeparator.displayName = "SelectSeparator";
