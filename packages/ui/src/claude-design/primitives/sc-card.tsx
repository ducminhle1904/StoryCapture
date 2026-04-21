import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export interface ScCardProps extends HTMLAttributes<HTMLDivElement> {
  title?: ReactNode;
  action?: ReactNode;
}

export const ScCard = forwardRef<HTMLDivElement, ScCardProps>(
  ({ title, action, className, children, ...rest }, ref) => (
    <div ref={ref} className={cn("sc-card", className)} {...rest}>
      {(title || action) && (
        <div className="sc-card-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          {title && <div className="sc-h">{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  ),
);
ScCard.displayName = "ScCard";
