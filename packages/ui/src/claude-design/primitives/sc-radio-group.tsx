"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScRadioGroup = forwardRef<
  ElementRef<typeof RadioGroup>,
  ComponentPropsWithoutRef<typeof RadioGroup>
>(({ className, ...props }, ref) => (
  <RadioGroup ref={ref} className={cn("sc-radio-group", className)} {...props} />
));
ScRadioGroup.displayName = "ScRadioGroup";

export const ScRadioGroupItem = forwardRef<
  ElementRef<typeof Radio.Root>,
  ComponentPropsWithoutRef<typeof Radio.Root>
>(({ className, ...props }, ref) => (
  <Radio.Root ref={ref} className={cn("sc-radio-item", className)} {...props}>
    <Radio.Indicator className="sc-radio-indicator" />
  </Radio.Root>
));
ScRadioGroupItem.displayName = "ScRadioGroupItem";
