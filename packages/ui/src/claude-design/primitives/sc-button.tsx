import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ScButtonVariant =
  | "default"
  | "primary"
  | "outline"
  | "ghost"
  | "danger"
  | "destructive"
  | "success"
  | "pill";
export type ScButtonSize = "default" | "sm" | "md" | "lg" | "icon";

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
  ) => {
    const variantClass = variant === "destructive" ? "danger" : variant;
    const sizeClass = size === "default" ? "md" : size;

    return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "sc-btn",
        variantClass !== "default" && variantClass,
        sizeClass !== "md" && sizeClass,
        className,
      )}
      {...rest}
    >
      {icon}
      {sizeClass !== "icon" && children}
      {iconRight}
      {kbd && <span className="sc-kbd" style={{ marginLeft: 4 }}>{kbd}</span>}
    </button>
    );
  },
);
ScButton.displayName = "ScButton";
