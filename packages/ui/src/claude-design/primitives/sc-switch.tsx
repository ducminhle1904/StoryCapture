import { Switch } from "@base-ui/react/switch";
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from "react";

import { cn } from "../../lib/cn";

export type ScSwitchProps = ComponentPropsWithoutRef<typeof Switch.Root>;

export const ScSwitch = forwardRef<ElementRef<typeof Switch.Root>, ScSwitchProps>(
  ({ className, ...props }, ref) => (
    <Switch.Root ref={ref} className={cn("sc-switch", className)} {...props}>
      <Switch.Thumb className="sc-switch-thumb" />
    </Switch.Root>
  ),
);
ScSwitch.displayName = "ScSwitch";
