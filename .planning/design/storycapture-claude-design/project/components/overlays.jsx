/* global React, I, Btn, Badge */
// Command palette, toast stack, recording indicator, modal

function CommandPalette({ open, onClose, onNavigate }) {
  const [q, setQ] = React.useState("");
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30); }, [open]);
  const ALL = [
    { id: "dashboard", label: "Go to Projects", group: "Navigate", icon: <I.Home size={13}/>, kbd: "⌘1" },
    { id: "editor",    label: "Go to Story Editor", group: "Navigate", icon: <I.Code size={13}/>, kbd: "⌘2" },
    { id: "post",      label: "Go to Post-Production", group: "Navigate", icon: <I.Scissors size={13}/>, kbd: "⌘3" },
    { id: "export",    label: "Render & Export…", group: "Navigate", icon: <I.Download size={13}/>, kbd: "⌘E" },
    { id: "settings",  label: "Open Settings", group: "Navigate", icon: <I.Settings size={13}/>, kbd: "⌘," },
    { id: "tokens",    label: "Open Design Tokens", group: "Navigate", icon: <I.Layers size={13}/> },
    { id: "components",label: "Open Component Samples", group: "Navigate", icon: <I.Grid size={13}/> },
    { id: "new-story", label: "New Story…", group: "Actions", icon: <I.Plus size={13}/>, kbd: "⌘N" },
    { id: "record",    label: "Start Recording", group: "Actions", icon: <I.Record size={13}/>, kbd: "⌘⇧R" },
    { id: "import",    label: "Import .story file", group: "Actions", icon: <I.FolderOpen size={13}/> },
    { id: "duplicate", label: "Duplicate current scene", group: "Actions", icon: <I.Copy size={13}/> },
    { id: "reveal",    label: "Reveal render in Finder", group: "Actions", icon: <I.Eye size={13}/> },
    { id: "docs",      label: "Open DSL reference", group: "Help", icon: <I.File size={13}/> },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "Help", icon: <I.Keyboard size={13}/>, kbd: "⌘/" },
  ];
  const filtered = ALL.filter(i => i.label.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(filtered.map(i => i.group))];
  if (!open) return null;
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 200,
      display: "grid", placeItems: "start center",
      paddingTop: 120, background: "rgba(0,0,0,0.4)",
      backdropFilter: "blur(6px)",
    }} onClick={onClose}>
      <div className="sc-animate-in" onClick={e => e.stopPropagation()}
        style={{
          width: 560, maxWidth: "90%",
          background: "var(--sc-surface)",
          border: "1px solid var(--sc-border-2)",
          borderRadius: "var(--sc-r-xl)",
          boxShadow: "var(--sc-sh-pop)",
          overflow: "hidden",
        }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--sc-border)" }}>
          <I.Search size={15} style={{ color: "var(--sc-text-4)" }}/>
          <input ref={inputRef} autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder="Type a command or search…"
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--sc-text)", fontSize: 14, fontFamily: "inherit" }}/>
          <span className="sc-kbd">esc</span>
        </div>
        <div style={{ maxHeight: 360, overflowY: "auto", padding: 6 }}>
          {groups.length === 0 && (
            <div style={{ padding: "30px 16px", textAlign: "center", color: "var(--sc-text-4)", fontSize: 12.5 }}>
              No commands found for “{q}”
            </div>
          )}
          {groups.map((g, gi) => (
            <div key={g} style={{ padding: "6px 0" }}>
              <div style={{ padding: "4px 10px 4px", fontSize: 10, fontWeight: 600, color: "var(--sc-text-4)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{g}</div>
              {filtered.filter(i => i.group === g).map((it, i) => {
                const first = gi === 0 && i === 0;
                return (
                  <div key={it.id}
                    onClick={() => { onNavigate(it.id); onClose(); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 10px",
                      borderRadius: "var(--sc-r-md)",
                      background: first ? "var(--sc-hover)" : "transparent",
                      cursor: "default",
                      fontSize: 12.5,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--sc-hover)"}
                    onMouseLeave={e => e.currentTarget.style.background = first ? "var(--sc-hover)" : "transparent"}>
                    <span style={{ width: 16, color: "var(--sc-text-3)" }}>{it.icon}</span>
                    <span style={{ flex: 1, color: "var(--sc-text)" }}>{it.label}</span>
                    {it.kbd && <span className="sc-kbd">{it.kbd}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{ borderTop: "1px solid var(--sc-border)", padding: "8px 14px", display: "flex", alignItems: "center", gap: 14, fontSize: 10.5, color: "var(--sc-text-4)" }}>
          <span><span className="sc-kbd">↑↓</span> navigate</span>
          <span><span className="sc-kbd">↵</span> select</span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5 }}>
            Powered by fuzzy search
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Recording indicator (floating pill) ─────────────────
function RecordingIndicator({ recording, elapsed, onStop }) {
  if (!recording) return null;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div style={{
      position: "absolute",
      top: 58, left: "50%", transform: "translateX(-50%)",
      zIndex: 80,
      display: "inline-flex", alignItems: "center", gap: 12,
      padding: "6px 6px 6px 14px",
      background: "var(--sc-n-975)",
      border: "1px solid oklch(0.65 0.20 22 / 0.4)",
      borderRadius: 999,
      boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.06)",
      color: "var(--sc-text)",
      fontSize: 12.5,
      fontWeight: 500,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: 99, background: "var(--sc-record)",
        animation: "sc-pulse 1.2s ease-in-out infinite",
      }}/>
      <span style={{ fontVariantNumeric: "tabular-nums", fontFamily: "var(--sc-font-mono)", fontWeight: 500 }}>
        REC · {mm}:{ss}
      </span>
      <span style={{ color: "var(--sc-text-4)", fontSize: 11.5 }}>· checkout_flow.story · scene 2/4</span>
      <Btn size="sm" variant="danger" icon={<I.Stop size={10}/>} onClick={onStop}>Stop</Btn>
    </div>
  );
}

// ─── Toast stack ─────────────────────────────────────────
function Toast({ t, onDismiss }) {
  const tone = { info: "info", success: "success", error: "record", warn: "warn" }[t.kind] || "info";
  const icon = {
    info: <I.Info size={14}/>,
    success: <I.Check size={14}/>,
    error: <I.AlertCircle size={14}/>,
    warn: <I.AlertCircle size={14}/>,
  }[t.kind] || <I.Info size={14}/>;
  const color = {
    info: "var(--sc-info)",
    success: "var(--sc-success)",
    error: "var(--sc-record)",
    warn: "var(--sc-warn)",
  }[t.kind];
  return (
    <div className="sc-animate-in" style={{
      width: 340,
      background: "var(--sc-surface)",
      border: "1px solid var(--sc-border-2)",
      borderRadius: "var(--sc-r-lg)",
      boxShadow: "var(--sc-sh-3)",
      padding: "12px 14px",
      display: "flex", gap: 10,
    }}>
      <span style={{ color, marginTop: 1 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.title}</div>
        {t.desc && <div style={{ fontSize: 11.5, color: "var(--sc-text-3)", marginTop: 2, lineHeight: 1.4 }}>{t.desc}</div>}
        {t.actions && (
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {t.actions.map((a, i) =>
              <Btn key={i} size="sm" variant={i === 0 ? "default" : "ghost"} onClick={() => { a.onClick?.(); onDismiss(); }}>{a.label}</Btn>
            )}
          </div>
        )}
      </div>
      <Btn variant="ghost" size="icon" icon={<I.X size={12} />} onClick={onDismiss} />
    </div>
  );
}

function ToastStack({ toasts, dismiss }) {
  return (
    <div style={{
      position: "absolute",
      bottom: 16, left: 16, zIndex: 90,
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      {toasts.map(t => <Toast key={t.id} t={t} onDismiss={() => dismiss(t.id)} />)}
    </div>
  );
}

// ─── Modal wrapper ───────────────────────────────────────
function Modal({ open, onClose, children, width = 560 }) {
  if (!open) return null;
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 150,
      display: "grid", placeItems: "center",
      background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
    }} onClick={onClose}>
      <div className="sc-animate-in" onClick={e => e.stopPropagation()}
        style={{
          width, maxWidth: "90%",
          background: "var(--sc-surface)",
          border: "1px solid var(--sc-border-2)",
          borderRadius: "var(--sc-r-xl)",
          boxShadow: "var(--sc-sh-pop)",
          overflow: "hidden",
        }}>
        {children}
      </div>
    </div>
  );
}

Object.assign(window, { CommandPalette, RecordingIndicator, ToastStack, Modal });
