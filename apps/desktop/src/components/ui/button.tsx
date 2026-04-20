/**
 * NOTE (deviation): Hand-written using `class-variance-authority` rather than
 * scaffolded via `npx shadcn@latest add button`. The shadcn CLI's `base-ui`
 * registry is currently new-york / vega style for Radix; the Base UI variant
 * proves the registry is selected in `components.json` but we ship a minimal
 * `<button>` primitive here to avoid a network call and registry-compat
 * detection at install time. This still satisfies D-32 (Base UI not Radix)
 * because the file does NOT import any Radix UI package.
 *
 * Plan 09 will replace this with the official shadcn Base UI Button when the
 * `base-vega` v4 entry is verified.
 */

import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-default)] text-sm font-normal transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] hover:text-[var(--color-hover)]",
        outline:
          "border border-[var(--color-border)] bg-transparent text-[var(--color-fg)] hover:text-[var(--color-hover)]",
        ghost:
          "bg-[rgba(38,37,30,0.06)] text-[var(--color-fg-secondary)] hover:text-[var(--color-hover)]",
        destructive: "bg-[var(--color-danger)] text-[var(--color-fg-primary)] hover:opacity-90",
        pill: "bg-[var(--color-bg-surface)] text-[var(--color-fg-secondary)] rounded-[var(--radius-pill)] hover:text-[var(--color-hover)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
