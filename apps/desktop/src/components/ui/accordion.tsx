/**
 * Accordion primitive — shadcn-style chrome on top of Base UI's Accordion.
 *
 * Token-only styling; animation rides `data-[starting-style]`.
 */

import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Accordion = BaseAccordion.Root;

export const AccordionItem = React.forwardRef<
  React.ElementRef<typeof BaseAccordion.Item>,
  React.ComponentPropsWithoutRef<typeof BaseAccordion.Item>
>(({ className, ...props }, ref) => (
  <BaseAccordion.Item
    ref={ref}
    className={cn("border-b border-[var(--color-border-subtle)] last:border-b-0", className)}
    {...props}
  />
));
AccordionItem.displayName = "AccordionItem";

export const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof BaseAccordion.Trigger>,
  React.ComponentPropsWithoutRef<typeof BaseAccordion.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseAccordion.Header className="flex">
    <BaseAccordion.Trigger
      ref={ref}
      className={cn(
        "group flex flex-1 items-center justify-between gap-2 py-3 text-left text-xs font-medium text-[var(--color-fg-primary)] outline-none transition-colors",
        "hover:text-[var(--color-hover)]",
        "focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDown
        size={13}
        aria-hidden="true"
        className="shrink-0 text-[var(--color-fg-muted)] transition-transform duration-150 group-data-[panel-open]:rotate-180"
      />
    </BaseAccordion.Trigger>
  </BaseAccordion.Header>
));
AccordionTrigger.displayName = "AccordionTrigger";

export const AccordionContent = React.forwardRef<
  React.ElementRef<typeof BaseAccordion.Panel>,
  React.ComponentPropsWithoutRef<typeof BaseAccordion.Panel>
>(({ className, children, ...props }, ref) => (
  <BaseAccordion.Panel
    ref={ref}
    className={cn(
      "overflow-hidden text-xs text-[var(--color-fg-secondary)]",
      "h-[var(--accordion-panel-height)] transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
      "data-[starting-style]:h-0 data-[ending-style]:h-0",
    )}
    {...props}
  >
    <div className={cn("pb-3 pt-0", className)}>{children}</div>
  </BaseAccordion.Panel>
));
AccordionContent.displayName = "AccordionContent";
