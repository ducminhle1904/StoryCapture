import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ScCalloutTone = "neutral" | "info" | "success" | "warn" | "danger";

export interface ScCalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: ScCalloutTone;
  title?: ReactNode;
  icon?: ReactNode;
}

export const ScCallout = forwardRef<HTMLDivElement, ScCalloutProps>(
  ({ tone = "neutral", title, icon, className, children, role, ...rest }, ref) => {
    const resolvedRole = role ?? (tone === "danger" || tone === "warn" ? "alert" : "status");

    return (
      <div
        ref={ref}
        className={cn("sc-callout", !icon && "no-icon", tone !== "neutral" && tone, className)}
        role={resolvedRole}
        {...rest}
      >
        {icon && <div className="sc-callout-icon">{icon}</div>}
        <div>
          {title && <div className="sc-callout-title">{title}</div>}
          <div className="sc-callout-body">{children}</div>
        </div>
      </div>
    );
  },
);
ScCallout.displayName = "ScCallout";
