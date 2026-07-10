// Action menu shown after the sidecar resolves an element pick. The user
// chooses what to do; only then does the desktop UI insert/replace the
// `.story` line and stamp the targets sidecar.

import {
  CheckCircle,
  Clock,
  Hand,
  type LucideIcon,
  MousePointer,
  MousePointerClick,
  Move,
  Pencil,
  Type,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SelectField } from "@/components/ui/select-field";
import type { PickElementMeta } from "@/ipc/picker";
import type { PickerAction, PickerActionItem, PickerActionOptions } from "./picker-action-dsl";

interface PickerActionMenuProps {
  targetLabel: string;
  defaultAction: PickerAction;
  items: PickerActionItem[];
  /** Drives select-action dropdown options. */
  meta?: PickElementMeta;
  onChoose: (action: PickerAction, options?: PickerActionOptions) => void;
  onCancel: () => void;
}

const ACTION_ICONS: Record<PickerAction, LucideIcon> = {
  click: MousePointerClick,
  hover: MousePointer,
  "wait-for": Clock,
  assert: CheckCircle,
  fill: Pencil,
  type: Type,
  select: Hand,
  upload: Upload,
  drag: Move,
};

type FormAction = "fill" | "type" | "select";
type ViewState = { kind: "list" } | { kind: "form"; action: FormAction };

const FORM_ACTIONS: ReadonlySet<PickerAction> = new Set<PickerAction>(["fill", "type", "select"]);

export function PickerActionMenu({
  targetLabel,
  defaultAction,
  items,
  meta,
  onChoose,
  onCancel,
}: PickerActionMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewState>({ kind: "list" });
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (view.kind !== "list") return;
    const root = containerRef.current;
    root?.querySelector<HTMLButtonElement>(`button[data-action="${defaultAction}"]`)?.focus();
  }, [view, defaultAction]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (view.kind === "form") {
          setView({ kind: "list" });
        } else {
          onCancel();
        }
        return;
      }
      if (view.kind === "list" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const root = containerRef.current;
        if (!root) return;
        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-action]"));
        if (buttons.length === 0) return;
        const active = document.activeElement;
        const idx = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = buttons[(idx + delta + buttons.length) % buttons.length];
        e.preventDefault();
        next?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, onCancel]);

  const handleListChoose = (action: PickerAction) => {
    if (FORM_ACTIONS.has(action)) {
      setDraft("");
      setView({ kind: "form", action: action as FormAction });
      return;
    }
    onChoose(action);
  };

  const submitForm = () => {
    if (view.kind !== "form") return;
    const value = draft.trim();
    if (!value) return;
    if (view.action === "select") {
      onChoose("select", { value });
    } else {
      onChoose(view.action, { text: value });
    }
  };

  if (typeof document === "undefined") return null;

  const formAction = view.kind === "form" ? view.action : null;
  const formLabel = formAction ? FORM_LABELS[formAction] : "";
  const optionLabels = formAction === "select" ? (meta?.optionLabels ?? []) : [];

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
      {view.kind === "list" ? (
        <ul className="flex flex-col py-1">
          {items.map(({ action, label }) => {
            const Icon = ACTION_ICONS[action];
            return (
              <li key={action} role="none">
                <button
                  type="button"
                  role="menuitem"
                  data-action={action}
                  onClick={() => handleListChoose(action)}
                  className={[
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                    "hover:bg-[var(--color-surface-200)]",
                    "focus-visible:bg-[var(--color-surface-200)] focus-visible:outline-none",
                  ].join(" ")}
                >
                  <Icon size={14} aria-hidden="true" className="text-[var(--color-fg-muted)]" />
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <FormBody
          label={formLabel}
          draft={draft}
          onChange={setDraft}
          onSubmit={submitForm}
          onBack={() => setView({ kind: "list" })}
          optionLabels={optionLabels}
        />
      )}
    </div>,
    document.body,
  );
}

const FORM_LABELS: Record<FormAction, string> = {
  fill: "Text to fill",
  type: "Text to type",
  select: "Option value",
};

function FormBody({
  label,
  draft,
  onChange,
  onSubmit,
  onBack,
  optionLabels,
}: {
  label: string;
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  optionLabels: string[];
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const canSubmit = draft.trim().length > 0;
  const useDropdown = optionLabels.length > 0;
  const fieldClass = [
    "h-7 rounded-[var(--radius-sm)] border border-[var(--color-border-default)]",
    "bg-[var(--color-surface-100)] px-2 text-[13px]",
    "focus-visible:outline-none focus-visible:border-[var(--color-focus-ring)]",
  ].join(" ");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-2 px-3 py-2"
    >
      <div className="text-[11px] font-mono uppercase tracking-wide text-[var(--color-fg-muted)]">
        {label}
      </div>
      {useDropdown ? (
        <SelectField
          value={draft}
          onValueChange={onChange}
          options={optionLabels.map((label) => ({ value: label, label }))}
          placeholder="Choose"
          aria-label={label}
          autoFocus
        />
      ) : (
        <input
          ref={(el) => {
            inputRef.current = el;
          }}
          type="text"
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={fieldClass}
        />
      )}
      <div className="flex justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className={[
            "h-7 rounded-[var(--radius-sm)] px-3 text-[12px] font-medium",
            "bg-[var(--color-accent-primary)] text-white",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          ].join(" ")}
        >
          Insert
        </button>
      </div>
    </form>
  );
}
