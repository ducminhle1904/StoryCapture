"use client";

import { Dialog } from "@base-ui/react/dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

import { cn } from "../../lib/cn";

export const ScDialog = Dialog.Root;
export const ScDialogTrigger = Dialog.Trigger;
export const ScDialogClose = Dialog.Close;
export const ScDialogTitle = Dialog.Title;
export const ScDialogDescription = Dialog.Description;

export const ScDialogContent = forwardRef<
  ElementRef<typeof Dialog.Popup>,
  ComponentPropsWithoutRef<typeof Dialog.Popup>
>(({ className, ...props }, ref) => (
  <Dialog.Portal>
    <Dialog.Backdrop className="sc-dialog-backdrop" />
    <Dialog.Viewport className="sc-dialog-viewport">
      <Dialog.Popup ref={ref} className={cn("sc-dialog-popup", className)} {...props} />
    </Dialog.Viewport>
  </Dialog.Portal>
));
ScDialogContent.displayName = "ScDialogContent";
