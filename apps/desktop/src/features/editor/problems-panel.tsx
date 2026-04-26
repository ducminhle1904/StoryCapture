import { ScBadge, ScKbd } from "@storycapture/ui";
import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { create } from "zustand";

import type { Diagnostic } from "@/ipc/parse";
import { EMPTY_DIAGNOSTICS, useEditorStore } from "@/state/editor";

interface ProblemsPanelStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useProblemsPanelStore = create<ProblemsPanelStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

interface ProblemsPanelProps {
  onJumpToOffset: (offset: number) => void;
}

const SEVERITY_ORDER: Record<Diagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_DOT_COLOR: Record<Diagnostic["severity"], string> = {
  error: "var(--sc-record)",
  warning: "var(--sc-warn)",
  info: "var(--sc-text-3)",
};

export function ProblemsPanel({ onJumpToOffset }: ProblemsPanelProps) {
  const diagnostics = useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;
  const open = useProblemsPanelStore((s) => s.open);
  const toggleOpen = useProblemsPanelStore((s) => s.toggle);
  const reduceMotion = useReducedMotion();

  useHotkeys(
    "mod+shift+m",
    (e) => {
      e.preventDefault();
      toggleOpen();
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  );

  const { sorted, errorCount, warningCount } = useMemo(() => {
    const next = [...diagnostics].sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.span.start - b.span.start,
    );
    let errors = 0;
    let warnings = 0;
    for (const d of diagnostics) {
      if (d.severity === "error") errors++;
      else if (d.severity === "warning") warnings++;
    }
    return { sorted: next, errorCount: errors, warningCount: warnings };
  }, [diagnostics]);
  const total = diagnostics.length;

  return (
    <section
      role="region"
      aria-label="Problems"
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        background: "var(--sc-surface-2)",
        borderTop: "1px solid var(--sc-border-2)",
      }}
    >
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls="problems-panel-body"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 28,
          padding: "0 12px",
          background: "transparent",
          border: "none",
          color: "var(--sc-text-2)",
          fontSize: 11.5,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <AlertTriangle size={12} aria-hidden="true" style={{ color: "var(--sc-text-3)" }} />
        <span style={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Problems
        </span>
        {errorCount > 0 && (
          <ScBadge tone="record">
            {errorCount} {errorCount === 1 ? "error" : "errors"}
          </ScBadge>
        )}
        {warningCount > 0 && (
          <ScBadge tone="warn">
            {warningCount} {warningCount === 1 ? "warning" : "warnings"}
          </ScBadge>
        )}
        {total === 0 && (
          <ScBadge tone="muted" icon={<Check size={10} aria-hidden="true" />}>
            No problems
          </ScBadge>
        )}
        <span style={{ flex: 1 }} />
        <ScKbd>⌘⇧M</ScKbd>
        <ChevronRight
          size={12}
          aria-hidden="true"
          style={{
            color: "var(--sc-text-3)",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 0.16s ease",
          }}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="problems-body"
            id="problems-panel-body"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 180, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            style={{ overflow: "hidden", borderTop: "1px solid var(--sc-border-2)" }}
          >
            <div
              style={{
                height: "100%",
                overflowY: "auto",
                fontFamily: "var(--sc-font-mono)",
                fontSize: 11.5,
              }}
            >
              {sorted.length === 0 ? (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--sc-text-4)",
                    fontStyle: "italic",
                  }}
                >
                  No problems detected
                </div>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {sorted.map((d, i) => (
                    <li key={`${d.span.start}-${i}`}>
                      <button
                        type="button"
                        onClick={() => onJumpToOffset(d.span.start)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          width: "100%",
                          padding: "4px 12px",
                          background: "transparent",
                          border: "none",
                          color: "var(--sc-text)",
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                        className="hover:bg-[var(--sc-hover)]"
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 99,
                            flexShrink: 0,
                            background: SEVERITY_DOT_COLOR[d.severity],
                          }}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span>{d.message}</span>
                          {d.suggestion && (
                            <span style={{ color: "var(--sc-text-3)", marginLeft: 6 }}>
                              {`did you mean "${d.suggestion}"?`}
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            color: "var(--sc-text-4)",
                            fontSize: 10,
                            flexShrink: 0,
                          }}
                        >
                          {`Ln ${d.span.line}, Col ${d.span.col}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
