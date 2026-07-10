/**
 * DropdownMenu primitive — shadcn-style API on top of Base UI Menu.
 */

import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export const DropdownMenu = BaseMenu.Root;
export const DropdownMenuTrigger = BaseMenu.Trigger;
export const DropdownMenuGroup = BaseMenu.Group;
export const DropdownMenuRadioGroup = BaseMenu.RadioGroup;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof BaseMenu.Popup>,
  React.ComponentPropsWithoutRef<typeof BaseMenu.Popup>
>(({ className, children, style, ...props }, ref) => (
  <BaseMenu.Portal>
    <BaseMenu.Positioner sideOffset={7} className="z-50 outline-none">
      <BaseMenu.Popup
        ref={ref}
        className={cn(
          "min-w-44 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] p-1.5 text-xs text-[var(--color-fg-primary)] shadow-[0_18px_42px_rgba(0,0,0,0.34),0_3px_10px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.06)]",
          "origin-[var(--transform-origin)] transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
          "data-[starting-style]:translate-y-[-3px] data-[starting-style]:scale-[0.975] data-[starting-style]:opacity-0",
          "data-[ending-style]:translate-y-[-3px] data-[ending-style]:scale-[0.975] data-[ending-style]:opacity-0",
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
      </BaseMenu.Popup>
    </BaseMenu.Positioner>
  </BaseMenu.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof BaseMenu.Item>,
  React.ComponentPropsWithoutRef<typeof BaseMenu.Item> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <BaseMenu.Item
    ref={ref}
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-[calc(var(--radius-md)-1px)] px-2.5 py-1.5 text-[12px] text-[var(--color-fg-secondary)] outline-none transition-[background,color,transform] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
      "data-[highlighted]:bg-[linear-gradient(90deg,color-mix(in_oklch,var(--color-accent-primary)_18%,transparent),transparent_74%),var(--color-surface-300)] data-[highlighted]:text-[var(--color-fg-primary)]",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      "active:translate-y-px",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof BaseMenu.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof BaseMenu.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <BaseMenu.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-[calc(var(--radius-md)-1px)] py-1.5 pl-8 pr-2.5 text-[12px] text-[var(--color-fg-secondary)] outline-none transition-[background,color,transform] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
      "data-[highlighted]:bg-[linear-gradient(90deg,color-mix(in_oklch,var(--color-accent-primary)_18%,transparent),transparent_74%),var(--color-surface-300)] data-[highlighted]:text-[var(--color-fg-primary)]",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      "active:translate-y-px",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2.5 flex h-3.5 w-3.5 items-center justify-center">
      <BaseMenu.CheckboxItemIndicator>
        <Check size={12} aria-hidden="true" className="text-[var(--color-accent-primary)]" />
      </BaseMenu.CheckboxItemIndicator>
    </span>
    {children}
  </BaseMenu.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof BaseMenu.RadioItem>,
  React.ComponentPropsWithoutRef<typeof BaseMenu.RadioItem>
>(({ className, children, ...props }, ref) => (
  <BaseMenu.RadioItem
    ref={ref}
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-[calc(var(--radius-md)-1px)] py-1.5 pl-8 pr-2.5 text-[12px] text-[var(--color-fg-secondary)] outline-none transition-[background,color,transform] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
      "data-[highlighted]:bg-[linear-gradient(90deg,color-mix(in_oklch,var(--color-accent-primary)_18%,transparent),transparent_74%),var(--color-surface-300)] data-[highlighted]:text-[var(--color-fg-primary)]",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      "active:translate-y-px",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2.5 flex h-3.5 w-3.5 items-center justify-center">
      <BaseMenu.RadioItemIndicator>
        <Circle
          size={7}
          aria-hidden="true"
          className="fill-[var(--color-accent-primary)] text-[var(--color-accent-primary)]"
        />
      </BaseMenu.RadioItemIndicator>
    </span>
    {children}
  </BaseMenu.RadioItem>
));
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof BaseMenu.GroupLabel>,
  React.ComponentPropsWithoutRef<typeof BaseMenu.GroupLabel> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <BaseMenu.GroupLabel
    ref={ref}
    className={cn(
      "px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-muted)]",
      inset && "pl-8",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <BaseMenu.Separator
    ref={ref}
    className={cn("my-1 h-px bg-[var(--color-border-subtle)]", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export const DropdownMenuSub = BaseMenu.SubmenuRoot;
export const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof BaseMenu.SubmenuTrigger>,
  React.ComponentPropsWithoutRef<typeof BaseMenu.SubmenuTrigger> & { inset?: boolean }
>(({ className, inset, children, ...props }, ref) => (
  <BaseMenu.SubmenuTrigger
    ref={ref}
    className={cn(
      "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-[calc(var(--radius-md)-1px)] px-2.5 py-1.5 text-[12px] text-[var(--color-fg-secondary)] outline-none transition-[background,color,transform] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
      "data-[highlighted]:bg-[linear-gradient(90deg,color-mix(in_oklch,var(--color-accent-primary)_18%,transparent),transparent_74%),var(--color-surface-300)] data-[highlighted]:text-[var(--color-fg-primary)]",
      inset && "pl-8",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight size={13} aria-hidden="true" className="ml-auto text-[var(--color-fg-muted)]" />
  </BaseMenu.SubmenuTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = DropdownMenuContent;
