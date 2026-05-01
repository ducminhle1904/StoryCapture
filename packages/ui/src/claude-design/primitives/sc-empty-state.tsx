import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export interface ScEmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  align?: "start" | "center";
}

export const ScEmptyState = forwardRef<HTMLDivElement, ScEmptyStateProps>(
  ({ title, body, icon, actions, align = "start", className, ...rest }, ref) => (
    <div ref={ref} className={cn("sc-empty", align === "center" && "center", className)} {...rest}>
      {icon && <div className="sc-empty-icon">{icon}</div>}
      <div className="sc-empty-title">{title}</div>
      {body && <div className="sc-empty-body">{body}</div>}
      {actions && <div className="sc-empty-actions">{actions}</div>}
    </div>
  ),
);
ScEmptyState.displayName = "ScEmptyState";
