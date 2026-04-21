import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type ScKbdProps = HTMLAttributes<HTMLElement>;

export const ScKbd = forwardRef<HTMLElement, ScKbdProps>(
  ({ className, children, ...rest }, ref) => (
    <kbd ref={ref} className={cn("sc-kbd", className)} {...rest}>
      {children}
    </kbd>
  ),
);
ScKbd.displayName = "ScKbd";
