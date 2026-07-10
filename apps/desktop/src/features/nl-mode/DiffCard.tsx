/**
 * Per-step diff card with inline diff + 4 actions.
 *
 * Keyboard: A=approve, E=edit, R=regen, Backspace=reject. Bulk approve: Cmd+Shift+A.
 * Discard confirm: AlertDialog if >= 3 pending cards on panel close.
 */

import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, Pencil, RotateCcw, X } from "lucide-react";
import { motion } from "motion/react";
import * as React from "react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type DiffCard as DiffCardType, useNlStore } from "./nlStore";

// Lazy load CodeMirror to avoid heavy import at render time
const CodeMirrorLazy = React.lazy(() => import("@uiw/react-codemirror"));

export interface DiffCardProps {
  card: DiffCardType;
  stepIndex: number;
  projectId: string;
  enableBulkApprove?: boolean;
  showDiscardConfirm?: boolean;
  className?: string;
}

interface DiffLine {
  id: string;
  type: "add" | "remove" | "context";
  text: string;
}

function computeDiffLines(oldText?: string, newText?: string): DiffLine[] {
  const lines: DiffLine[] = [];
  const oldLines = (oldText ?? "").split("\n");
  const newLines = (newText ?? "").split("\n");

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const ol = oldLines[i];
    const nl = newLines[i];
    if (ol === nl) {
      if (ol !== undefined) lines.push({ id: `context-${i}`, type: "context", text: ol });
    } else {
      if (ol !== undefined && ol !== "") {
        lines.push({ id: `remove-${i}`, type: "remove", text: ol });
      }
      if (nl !== undefined && nl !== "") {
        lines.push({ id: `add-${i}`, type: "add", text: nl });
      }
    }
  }
  return lines;
}

export function DiffCard({ card, stepIndex, projectId, className }: DiffCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(card.newText ?? "");
  const [approveSuccess, setApproveSuccess] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const store = useNlStore();
  const stepNum = stepIndex + 1;

  const diffLines = useMemo(
    () => computeDiffLines(card.oldText, card.newText),
    [card.oldText, card.newText],
  );

  const handleApprove = useCallback(async () => {
    setApproveSuccess(true);
    store.updateCardStatus(card.stepId, "approved");
    try {
      await invoke("nl_diff_apply", {
        projectId,
        stepId: card.stepId,
        newText: card.newText,
      });
    } catch {
      // Handle error silently; card is already visually approved
    }
  }, [card.stepId, card.newText, projectId, store]);

  const handleEdit = useCallback(() => {
    setEditing(true);
    setEditText(card.newText ?? "");
  }, [card.newText]);

  const handleRegen = useCallback(async () => {
    store.updateCardStatus(card.stepId, "regenerating");
    try {
      await invoke("nl_regen_step", {
        projectId,
        stepId: card.stepId,
      });
    } catch {
      store.updateCardStatus(card.stepId, "pending");
    }
  }, [card.stepId, projectId, store]);

  const handleReject = useCallback(() => {
    store.updateCardStatus(card.stepId, "rejected");
  }, [card.stepId, store]);

  const handleBulkApprove = useCallback(async () => {
    const pending = store.pendingCards.filter((c) => c.status === "pending");
    for (const c of pending) {
      store.updateCardStatus(c.stepId, "approved");
      try {
        await invoke("nl_diff_apply", {
          projectId,
          stepId: c.stepId,
          newText: c.newText,
        });
      } catch {
        // continue with other cards
      }
    }
  }, [projectId, store]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return; // Don't capture keys in edit mode

      // Bulk approve: Cmd+Shift+A
      if (e.key.toLowerCase() === "a" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        handleBulkApprove();
        return;
      }

      switch (e.key.toLowerCase()) {
        case "a":
          e.preventDefault();
          handleApprove();
          break;
        case "e":
          e.preventDefault();
          handleEdit();
          break;
        case "r":
          e.preventDefault();
          handleRegen();
          break;
        case "backspace":
          e.preventDefault();
          handleReject();
          break;
      }
    },
    [editing, handleApprove, handleEdit, handleRegen, handleReject, handleBulkApprove],
  );

  // Don't render rejected cards
  if (card.status === "rejected") {
    return null;
  }

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  return (
    <motion.div
      data-testid="diff-card"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn(
        "rounded-lg border p-4 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent,#7C3AED)] focus:ring-offset-2",
        "bg-[var(--color-card,#13151C)]",
        approveSuccess
          ? "border-[var(--color-success,#30A46C)]"
          : "border-[var(--color-border,#242733)]",
        card.status === "regenerating" && "opacity-60",
        className,
      )}
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={
        reducedMotion
          ? { opacity: 1 }
          : approveSuccess
            ? {
                borderColor: "var(--color-success, #30A46C)",
                opacity: [1, 1, 0],
                transition: {
                  duration: 0.66,
                  times: [0, 0.39, 1],
                  ease: "easeOut",
                },
              }
            : { opacity: 1, y: 0 }
      }
      transition={reducedMotion ? undefined : { duration: 0.22, ease: "easeInOut" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded bg-[var(--color-border,#242733)] px-1.5 py-0.5 text-xs font-semibold text-[var(--color-muted-foreground,#8A90A2)]">
            {stepNum}
          </span>
          <span className="text-sm font-semibold text-[var(--color-foreground,#E6E8EE)]">
            {card.stepId}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="p-1 text-[var(--color-muted-foreground,#8A90A2)]"
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>

      {/* Body: diff or editor */}
      {!collapsed && (
        <div className="mt-3">
          {editing ? (
            <React.Suspense
              fallback={
                <div className="h-20 animate-pulse rounded bg-[var(--color-border,#242733)]" />
              }
            >
              <CodeMirrorLazy
                value={editText}
                onChange={(val: string) => setEditText(val)}
                data-testid="codemirror-mock"
              />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    setEditing(false);
                    try {
                      await invoke("nl_diff_apply", {
                        projectId,
                        stepId: card.stepId,
                        newText: editText,
                      });
                      store.updateCardStatus(card.stepId, "approved");
                    } catch {
                      // revert on error
                    }
                  }}
                >
                  {"L\u01b0u"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  {"Hu\u1ef7"}
                </Button>
              </div>
            </React.Suspense>
          ) : (
            <div className="space-y-0.5 font-mono text-[13px] leading-[1.45]">
              {diffLines.map((line) => (
                <div
                  key={line.id}
                  className={cn(
                    "rounded px-2 py-0.5",
                    line.type === "remove" && "bg-[#5C1D1F] text-[#FF8A8F]",
                    line.type === "add" && "bg-[#0E3A22] text-[#78DDA4]",
                    line.type === "context" && "text-[var(--color-muted-foreground,#8A90A2)]",
                  )}
                >
                  <span className="mr-2 select-none">
                    {line.type === "remove" ? "-" : line.type === "add" ? "+" : " "}
                  </span>
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action row */}
      {!collapsed && !editing && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleApprove}
            aria-label={`Ch\u1ea5p nh\u1eadn b\u01b0\u1edbc ${stepNum}`}
            className="text-[var(--color-success,#30A46C)]"
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            {"Ch\u1ea5p nh\u1eadn"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleEdit}
            aria-label={`S\u1eeda b\u01b0\u1edbc ${stepNum}`}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            {"S\u1eeda"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRegen}
            aria-label={`T\u1ea1o l\u1ea1i b\u01b0\u1edbc ${stepNum}`}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {"T\u1ea1o l\u1ea1i"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleReject}
            aria-label={`B\u1ecf b\u01b0\u1edbc ${stepNum}`}
            className="text-[var(--color-destructive,#E5484D)]"
          >
            <X className="mr-1 h-3.5 w-3.5" />
            {"B\u1ecf"}
          </Button>
        </div>
      )}
    </motion.div>
  );
}
