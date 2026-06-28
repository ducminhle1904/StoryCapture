import { Input as BaseInput } from "@base-ui/react/input";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

type BaseInputProps = ComponentPropsWithoutRef<typeof BaseInput>;

export interface ScInputProps extends BaseInputProps {
  icon?: ReactNode;
  kbd?: string;
}

export const ScInput = forwardRef<ElementRef<typeof BaseInput>, ScInputProps>(
  ({ className, icon, kbd, ...props }, ref) => {
    const input = (
      <BaseInput ref={ref} className={cn("sc-input", className)} {...props} />
    );
    if (!icon && !kbd) return input;
    return (
      <div className="sc-input-wrap">
        {icon && <span className="icon">{icon}</span>}
        {input}
        {kbd && <span className="sc-kbd" style={{ position: "absolute", right: 6 }}>{kbd}</span>}
      </div>
    );
  },
);
ScInput.displayName = "ScInput";
