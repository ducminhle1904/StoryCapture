import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ScButtonVariant = "default" | "primary" | "ghost" | "danger" | "success";
export type ScButtonSize = "sm" | "md" | "lg" | "icon";

export interface ScButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ScButtonVariant;
  size?: ScButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  kbd?: string;
}

export const ScButton = forwardRef<HTMLButtonElement, ScButtonProps>(
  (
    { variant = "default", size = "md", icon, iconRight, kbd, className, children, type, ...rest },
    ref,
  ) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "sc-btn",
        variant !== "default" && variant,
        size !== "md" && size,
        className,
      )}
      {...rest}
    >
      {icon}
      {size !== "icon" && children}
      {iconRight}
      {kbd && <span className="sc-kbd" style={{ marginLeft: 4 }}>{kbd}</span>}
    </button>
  ),
);
ScButton.displayName = "ScButton";
