import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { Prec } from "@codemirror/state";

import {
  simulatorCancel,
  simulatorStart,
  simulatorStepTo,
} from "@/ipc/simulator";
import { useEditorStore } from "@/state/editor";
import { useSimulatorStore } from "@/state/simulatorStore";

import { buildOrdinalLineMap } from "./simulator-decoration";

export interface SimulatorKeymapContext {
  getProjectFolder: () => string | null;
  getStoryPath: () => string | null;
  getStreamId: () => string | null;
}

function startOrStepTo(
  ord: number,
  ctx: SimulatorKeymapContext,
): boolean {
  const { runState, sessionId } = useSimulatorStore.getState();
  if (runState === "running") return true;
  const streamId = ctx.getStreamId();
  const projectFolder = ctx.getProjectFolder();
  const storyPath = ctx.getStoryPath();
  const storySource = useEditorStore.getState().source;
  if (runState === "paused" && sessionId) {
    void simulatorStepTo(sessionId, ord);
    return true;
  }
  if (!streamId || !projectFolder || !storyPath) return true;
  void simulatorStart(
    { projectFolder, storySource, storyPath, streamId, stopAfterOrdinal: ord },
    (e) => useSimulatorStore.getState().handleEvent(e),
  );
  return true;
}

export function createSimulatorKeymap(ctx: SimulatorKeymapContext) {
  const bindings: KeyBinding[] = [
    {
      key: "Mod-.",
      preventDefault: true,
      run: (view) => {
        const line = view.state.doc.lineAt(view.state.selection.main.head).number;
        const ast = useEditorStore.getState().lastParse?.ast ?? null;
        if (!ast) return false;
        const { lineToOrdinal } = buildOrdinalLineMap(
          ast as unknown as { scenes: Array<{ commands: Array<{ span: { line: number } }> }> },
        );
        const ord = lineToOrdinal(line);
        if (ord === null) return false;
        return startOrStepTo(ord, ctx);
      },
    },
    {
      key: "Mod-Shift-.",
      preventDefault: true,
      run: () => {
        const { runState } = useSimulatorStore.getState();
        if (runState === "running") return true;
        const streamId = ctx.getStreamId();
        const projectFolder = ctx.getProjectFolder();
        const storyPath = ctx.getStoryPath();
        const storySource = useEditorStore.getState().source;
        if (!streamId || !projectFolder || !storyPath) return true;
        void simulatorStart(
          {
            projectFolder,
            storySource,
            storyPath,
            streamId,
            stopAfterOrdinal: undefined,
          },
          (e) => useSimulatorStore.getState().handleEvent(e),
        );
        return true;
      },
    },
    {
      key: "Escape",
      run: () => {
        const { runState, sessionId } = useSimulatorStore.getState();
        if ((runState === "running" || runState === "paused") && sessionId) {
          void simulatorCancel(sessionId);
          return true;
        }
        return false;
      },
    },
  ];
  return [Prec.high(keymap.of(bindings)), createContextMenu(ctx)];
}

function createContextMenu(ctx: SimulatorKeymapContext) {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos).number;
      const ast = useEditorStore.getState().lastParse?.ast ?? null;
      if (!ast) return false;
      const { lineToOrdinal } = buildOrdinalLineMap(
        ast as unknown as {
          scenes: Array<{ commands: Array<{ span: { line: number } }> }>;
        },
      );
      const ord = lineToOrdinal(line);
      if (ord === null) return false;

      event.preventDefault();
      showPreviewToHereMenu(event.clientX, event.clientY, ord, ctx);
      return true;
    },
  });
}

function showPreviewToHereMenu(
  x: number,
  y: number,
  ord: number,
  ctx: SimulatorKeymapContext,
) {
  document.querySelectorAll("[data-simulator-ctxmenu]").forEach((n) => n.remove());

  const { runState } = useSimulatorStore.getState();
  const disabled = runState === "running";

  const menu = document.createElement("div");
  menu.setAttribute("data-simulator-ctxmenu", "");
  menu.setAttribute("role", "menu");
  Object.assign(menu.style, {
    position: "fixed",
    left: `${x}px`,
    top: `${y}px`,
    zIndex: "50",
    minWidth: "220px",
    padding: "4px",
    borderRadius: "6px",
    border: "1px solid var(--color-border-subtle)",
    background: "var(--color-surface-200)",
    boxShadow: "0 8px 20px rgba(0,0,0,0.24)",
    fontSize: "12px",
    color: "var(--color-fg-primary)",
  } as Partial<CSSStyleDeclaration>);

  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.setAttribute("aria-keyshortcuts", "Meta+Period");
  item.disabled = disabled;
  Object.assign(item.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "6px 8px",
    background: "transparent",
    border: "none",
    color: disabled ? "var(--color-fg-muted)" : "var(--color-fg-primary)",
    textAlign: "left",
    cursor: disabled ? "not-allowed" : "pointer",
    borderRadius: "4px",
  } as Partial<CSSStyleDeclaration>);
  const label = document.createElement("span");
  label.textContent = disabled
    ? "Preview to here — run in progress"
    : "Preview to here";
  const hint = document.createElement("kbd");
  hint.textContent = "⌘.";
  Object.assign(hint.style, {
    marginLeft: "auto",
    padding: "1px 6px",
    borderRadius: "4px",
    background: "var(--color-surface-300)",
    color: "var(--color-accent-primary)",
    fontFamily: "var(--sc-font-mono)",
    fontSize: "10px",
  } as Partial<CSSStyleDeclaration>);
  item.appendChild(label);
  item.appendChild(hint);
  item.addEventListener("click", () => {
    if (!disabled) startOrStepTo(ord, ctx);
    menu.remove();
  });
  menu.appendChild(item);

  const dismiss = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);

  document.body.appendChild(menu);
}
