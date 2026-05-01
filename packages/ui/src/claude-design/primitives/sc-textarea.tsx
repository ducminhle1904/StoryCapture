import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type ScTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const ScTextarea = forwardRef<HTMLTextAreaElement, ScTextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn("sc-input sc-textarea", className)} {...props} />
  ),
);
ScTextarea.displayName = "ScTextarea";
