"use client";

import { Accordion } from "@base-ui/react/accordion";
import { ChevronDown } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScAccordion = Accordion.Root;

export const ScAccordionItem = forwardRef<
  ElementRef<typeof Accordion.Item>,
  ComponentPropsWithoutRef<typeof Accordion.Item>
>(({ className, ...props }, ref) => (
  <Accordion.Item ref={ref} className={cn("sc-accordion-item", className)} {...props} />
));
ScAccordionItem.displayName = "ScAccordionItem";

export const ScAccordionTrigger = forwardRef<
  ElementRef<typeof Accordion.Trigger>,
  ComponentPropsWithoutRef<typeof Accordion.Trigger>
>(({ className, children, ...props }, ref) => (
  <Accordion.Header className="sc-accordion-header">
    <Accordion.Trigger ref={ref} className={cn("sc-accordion-trigger", className)} {...props}>
      <span>{children}</span>
      <ChevronDown className="sc-accordion-chevron" aria-hidden="true" size={14} />
    </Accordion.Trigger>
  </Accordion.Header>
));
ScAccordionTrigger.displayName = "ScAccordionTrigger";

export const ScAccordionContent = forwardRef<
  ElementRef<typeof Accordion.Panel>,
  ComponentPropsWithoutRef<typeof Accordion.Panel>
>(({ className, children, ...props }, ref) => (
  <Accordion.Panel ref={ref} className={cn("sc-accordion-panel", className)} {...props}>
    <div className="sc-accordion-content">{children}</div>
  </Accordion.Panel>
));
ScAccordionContent.displayName = "ScAccordionContent";
