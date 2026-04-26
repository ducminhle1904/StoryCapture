// Action menu shown after the sidecar resolves an element pick. The user
// chooses what to do with the picked element; only then does the desktop UI
// insert/replace the `.story` line and stamp the targets sidecar.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle,
  Clock,
  MousePointer,
  MousePointerClick,
  type LucideIcon,
} from "lucide-react";

import type { TargetVerb } from "./picker-emit-rewrite";

interface PickerActionMenuProps {
  targetLabel: string;
  defaultAction: TargetVerb;
  onChoose: (action: TargetVerb) => void;
  onCancel: () => void;
}

interface ActionDef {
  action: TargetVerb;
  label: string;
  icon: LucideIcon;
}

const ACTIONS: readonly ActionDef[] = [
  { action: "click", label: "Click element", icon: MousePointerClick },
  { action: "hover", label: "Hover element", icon: MousePointer },
  { action: "wait-for", label: "Wait for element", icon: Clock },
  { action: "assert", label: "Assert element", icon: CheckCircle },
] as const;

export function PickerActionMenu({
  targetLabel,
  defaultAction,
  onChoose,
  onCancel,
}: PickerActionMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    root
      .querySelector<HTMLButtonElement>(`button[data-action="${defaultAction}"]`)
      ?.focus();
  }, [defaultAction]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const root = containerRef.current;
        if (!root) return;
        const buttons = Array.from(
          root.querySelectorAll<HTMLButtonElement>("button[data-action]"),
        );
        if (buttons.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        const idx = buttons.findIndex((b) => b === active);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = buttons[(idx + delta + buttons.length) % buttons.length];
        e.preventDefault();
        next?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Picker action menu"
      className={[
        "fixed left-1/2 top-20 z-50 -translate-x-1/2",
        "min-w-[260px] rounded-[var(--radius-sm)]",
        "border border-[var(--color-border-strong)]",
        "bg-[var(--color-surface-200)] text-[var(--color-fg-primary)]",
        "shadow-2xl ring-1 ring-black/40",
      ].join(" ")}
    >
      <div
        className={[
          "px-3 py-2 text-[11px] font-mono uppercase tracking-wide",
          "text-[var(--color-fg-muted)]",
          "border-b border-[var(--color-border-default)]",
        ].join(" ")}
      >
        {targetLabel}
      </div>
      <ul className="flex flex-col py-1" role="menu">
        {ACTIONS.map(({ action, label, icon: Icon }) => (
          <li key={action} role="none">
            <button
              type="button"
              role="menuitem"
              data-action={action}
              onClick={() => onChoose(action)}
              className={[
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                "hover:bg-[var(--color-surface-200)]",
                "focus-visible:bg-[var(--color-surface-200)] focus-visible:outline-none",
              ].join(" ")}
            >
              <Icon
                size={14}
                aria-hidden="true"
                className="text-[var(--color-fg-muted)]"
              />
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
