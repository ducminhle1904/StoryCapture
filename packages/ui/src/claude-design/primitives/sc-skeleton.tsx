import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type ScSkeletonVariant = "text" | "block" | "circle";

export interface ScSkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: ScSkeletonVariant;
}

export const ScSkeleton = forwardRef<HTMLDivElement, ScSkeletonProps>(
  ({ variant = "block", className, ...rest }, ref) => (
    <div ref={ref} className={cn("sc-skeleton", variant, className)} aria-hidden="true" {...rest} />
  ),
);
ScSkeleton.displayName = "ScSkeleton";
