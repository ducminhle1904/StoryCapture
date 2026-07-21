// Action menu shown after the sidecar resolves an element pick. The user
// chooses what to do; only then does the desktop UI insert/replace the
// `.story` line and stamp the targets sidecar.

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import {
  ArrowUpDown,
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
import type { ScrollDir, ScrollUnit } from "@/ipc/parse";
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
  scroll: ArrowUpDown,
};

type FormAction = "fill" | "type" | "select" | "scroll";
type ViewState = { kind: "list" } | { kind: "form"; action: FormAction };

function parsePositiveAmount(value: string): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

const FORM_ACTIONS: ReadonlySet<PickerAction> = new Set<PickerAction>([
  "fill",
  "type",
  "select",
  "scroll",
]);

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
  const [scrollDirection, setScrollDirection] = useState<ScrollDir>("down");
  const [scrollUnit, setScrollUnit] = useState<ScrollUnit>("px");

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
        const active = document.activeElement as HTMLElement | null;
        const idx = buttons.indexOf(active as HTMLButtonElement);
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
    } else if (view.action === "scroll") {
      const amount = parsePositiveAmount(value);
      if (amount === null) return;
      onChoose("scroll", {
        direction: scrollDirection,
        amount,
        unit: scrollUnit,
      });
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
        "min-w-[260px] rounded-[var(--radius-inner)]",
        "border border-[var(--color-border-emphasized)]",
        "bg-[var(--color-background-surface)] text-[var(--color-text-primary)]",
        "shadow-2xl ring-1 ring-black/40",
      ].join(" ")}
    >
      <div
        className={[
          "px-3 py-2 text-[11px] font-mono uppercase tracking-wide",
          "text-[var(--color-text-secondary)]",
          "border-b border-[var(--color-border)]",
        ].join(" ")}
      >
        {targetLabel}
      </div>
      {view.kind === "list" ? (
        <div className="flex flex-col py-1" role="menu">
          {items.map(({ action, label }) => {
            const Icon = ACTION_ICONS[action];
            return (
              <div key={action} role="none">
                <AstryxButton
                  variant="ghost"
                  size="sm"
                  role="menuitem"
                  data-action={action}
                  onClick={() => handleListChoose(action)}
                  label={label}
                  className="w-full justify-start"
                  icon={<Icon size={14} aria-hidden="true" />}
                >
                  <span>{label}</span>
                </AstryxButton>
              </div>
            );
          })}
        </div>
      ) : (
        <FormBody
          action={view.action}
          label={formLabel}
          draft={draft}
          onChange={setDraft}
          onSubmit={submitForm}
          onBack={() => setView({ kind: "list" })}
          optionLabels={optionLabels}
          scrollDirection={scrollDirection}
          scrollUnit={scrollUnit}
          onScrollDirectionChange={setScrollDirection}
          onScrollUnitChange={setScrollUnit}
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
  scroll: "Scroll amount",
};

function FormBody({
  action,
  label,
  draft,
  onChange,
  onSubmit,
  onBack,
  optionLabels,
  scrollDirection,
  scrollUnit,
  onScrollDirectionChange,
  onScrollUnitChange,
}: {
  action: FormAction;
  label: string;
  draft: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  optionLabels: string[];
  scrollDirection: ScrollDir;
  scrollUnit: ScrollUnit;
  onScrollDirectionChange: (value: ScrollDir) => void;
  onScrollUnitChange: (value: ScrollUnit) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const canSubmit =
    action === "scroll" ? parsePositiveAmount(draft) !== null : draft.trim().length > 0;
  const useDropdown = action === "select" && optionLabels.length > 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-2 px-3 py-2"
    >
      <div className="text-[11px] font-mono uppercase tracking-wide text-[var(--color-text-secondary)]">
        {label}
      </div>
      {action === "scroll" ? (
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-2">
          <AstryxSelector
            value={scrollDirection}
            onChange={(value) => onScrollDirectionChange(value as ScrollDir)}
            options={[
              { value: "down", label: "Down" },
              { value: "up", label: "Up" },
              { value: "right", label: "Right" },
              { value: "left", label: "Left" },
            ]}
            label="Scroll direction"
            isLabelHidden
          />
          <AstryxTextInput
            ref={(el) => {
              inputRef.current = el;
            }}
            value={draft}
            onChange={onChange}
            label="Scroll amount"
            isLabelHidden
          />
          <AstryxSelector
            value={scrollUnit}
            onChange={(value) => onScrollUnitChange(value as ScrollUnit)}
            options={[
              { value: "px", label: "px" },
              { value: "vh", label: "vh" },
            ]}
            label="Scroll unit"
            isLabelHidden
          />
        </div>
      ) : useDropdown ? (
        <AstryxSelector
          value={draft}
          onChange={onChange}
          options={optionLabels.map((label) => ({ value: label, label }))}
          placeholder="Choose"
          label={label}
          isLabelHidden
          isDefaultOpen
        />
      ) : (
        <AstryxTextInput
          ref={(el) => {
            inputRef.current = el;
          }}
          value={draft}
          onChange={onChange}
          label={label}
          isLabelHidden
        />
      )}
      <div className="flex justify-between gap-2 pt-1">
        <AstryxButton type="button" variant="ghost" size="sm" onClick={onBack} label="Back">
          Back
        </AstryxButton>
        <AstryxButton
          type="submit"
          variant="primary"
          size="sm"
          isDisabled={!canSubmit}
          label="Insert action"
        >
          Insert
        </AstryxButton>
      </div>
    </form>
  );
}
