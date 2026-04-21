/* global React, I, Btn, Badge, Input, Switch, Segmented */
const { useState: useStateC, useEffect: useEffectC } = React;

// ─── Title bar with platform-aware chrome ────────────────
function TitleBar({ platform, title, subtitle }) {
  if (platform === "win") {
    return (
      <div className="sc-titlebar">
        <div className="sc-titlebar-title">
          <div className="sc-brand-mark" style={{ width: 14, height: 14, borderRadius: 3 }} />
          <span style={{ color: "var(--sc-text)", fontWeight: 600 }}>{title}</span>
          {subtitle && <span style={{ color: "var(--sc-text-4)", fontWeight: 400 }}>— {subtitle}</span>}
        </div>
        <div className="sc-win-caption">
          <div className="sc-win-btn" title="Minimize"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg></div>
          <div className="sc-win-btn" title="Maximize"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor"/></svg></div>
          <div className="sc-win-btn close" title="Close"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg></div>
        </div>
      </div>
    );
  }
  return (
    <div className="sc-titlebar">
      <div className="sc-traffic">
        <div className="sc-traffic-dot close" />
        <div className="sc-traffic-dot min" />
        <div className="sc-traffic-dot max" />
      </div>
      <div className="sc-titlebar-title">
        {title}
        {subtitle && <span style={{ color: "var(--sc-text-4)", fontWeight: 400 }}> — {subtitle}</span>}
      </div>
      <div />
    </div>
  );
}

// ─── Side nav ────────────────────────────────────────────
const NAV = [
  { group: "Workspace", items: [
    { id: "dashboard", label: "Projects",      icon: <I.Home size={14} /> },
    { id: "editor",    label: "Story Editor",  icon: <I.Code size={14} /> },
    { id: "post",      label: "Post-Production", icon: <I.Scissors size={14} /> },
  ]},
  { group: "Output", items: [
    { id: "export",    label: "Render & Export", icon: <I.Download size={14} /> },
    { id: "renders",   label: "Recent Renders",  icon: <I.Film size={14} />, badge: "12" },
  ]},
  { group: "System", items: [
    { id: "settings",  label: "Settings",        icon: <I.Settings size={14} /> },
    { id: "tokens",    label: "Design Tokens",   icon: <I.Layers size={14} /> },
    { id: "components",label: "Components",      icon: <I.Grid size={14} /> },
  ]},
];

function SideNav({ active, onChange, onOpenPalette, onStartRecord, recording }) {
  return (
    <div className="sc-nav">
      <div className="sc-brand">
        <div className="sc-brand-mark" />
        <div>
          <div className="sc-brand-name">StoryCapture</div>
          <div style={{ fontSize: 10.5, color: "var(--sc-text-4)", marginTop: 1 }}>v0.4.2 · Tauri</div>
        </div>
      </div>

      <div style={{ padding: "4px 10px 8px" }}>
        <div className="sc-btn" style={{ width: "100%", justifyContent: "space-between", background: "var(--sc-surface-2)" }}
          onClick={onOpenPalette}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--sc-text-3)" }}>
            <I.Search size={13} /> Search & commands
          </span>
          <span className="sc-kbd">⌘K</span>
        </div>
      </div>

      <div className="sc-scroll" style={{ flex: 1, paddingBottom: 10 }}>
        {NAV.map(g => (
          <div key={g.group} className="sc-nav-section">
            <div className="sc-nav-label">{g.group}</div>
            {g.items.map(it => (
              <div key={it.id} className={`sc-nav-item ${active === it.id ? "active" : ""}`} onClick={() => onChange(it.id)}>
                <span style={{ width: 14, display: "grid", placeItems: "center", color: active === it.id ? "var(--sc-accent-400)" : "var(--sc-text-3)" }}>{it.icon}</span>
                <span>{it.label}</span>
                {it.badge && <span className="sc-kbd" style={{ marginLeft: "auto" }}>{it.badge}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Record FAB + user footer */}
      <div style={{ padding: 10, borderTop: "1px solid var(--sc-border)" }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <Btn variant={recording ? "danger" : "primary"} size="sm" icon={recording ? <I.Stop size={12}/> : <I.Record size={11}/>} onClick={onStartRecord} style={{ flex: 1, justifyContent: "center" }}>
            {recording ? "Stop recording" : "Record"}
          </Btn>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="sc-avatar">EW</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Eleanor Walsh</div>
            <div style={{ fontSize: 10.5, color: "var(--sc-text-4)" }}>Pro · workspace-1</div>
          </div>
          <I.Settings size={12} style={{ marginLeft: "auto", color: "var(--sc-text-4)" }} />
        </div>
      </div>
    </div>
  );
}

// ─── Tweaks panel ─────────────────────────────────────────
function TweaksPanel({ open, onClose, tweaks, setTweaks }) {
  if (!open) return null;
  const set = (k, v) => setTweaks({ ...tweaks, [k]: v });
  const HUES = [
    { v: 78,  label: "Amber" },
    { v: 250, label: "Blue" },
    { v: 170, label: "Teal" },
    { v: 300, label: "Violet" },
    { v: 22,  label: "Red" },
  ];
  return (
    <div className="sc-animate-in" style={{
      position: "absolute", right: 16, bottom: 16, zIndex: 100,
      width: 280,
      background: "var(--sc-surface)",
      border: "1px solid var(--sc-border-2)",
      borderRadius: "var(--sc-r-lg)",
      boxShadow: "var(--sc-sh-pop)",
      overflow: "hidden",
    }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--sc-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <I.Wand size={13} /> Tweaks
        </div>
        <Btn variant="ghost" size="icon" icon={<I.X size={12} />} onClick={onClose} />
      </div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--sc-text-3)", marginBottom: 6, fontWeight: 500 }}>Theme</div>
          <Segmented value={tweaks.theme} onChange={v => set("theme", v)} options={[
            { value: "dark", label: "Dark", icon: <I.Moon size={11} /> },
            { value: "light", label: "Light", icon: <I.Sun size={11} /> },
          ]}/>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--sc-text-3)", marginBottom: 6, fontWeight: 500 }}>Platform chrome</div>
          <Segmented value={tweaks.platform} onChange={v => set("platform", v)} options={[
            { value: "mac", label: "macOS" },
            { value: "win", label: "Windows" },
          ]}/>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--sc-text-3)", marginBottom: 6, fontWeight: 500 }}>Density</div>
          <Segmented value={tweaks.density} onChange={v => set("density", v)} options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}/>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--sc-text-3)", marginBottom: 6, fontWeight: 500 }}>Radius</div>
          <Segmented value={tweaks.radius} onChange={v => set("radius", v)} options={[
            { value: "sharp", label: "Sharp" },
            { value: "md", label: "Default" },
            { value: "lg", label: "Round" },
          ]}/>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--sc-text-3)", marginBottom: 6, fontWeight: 500 }}>Accent hue</div>
          <div style={{ display: "flex", gap: 6 }}>
            {HUES.map(h => (
              <div key={h.v} onClick={() => set("accentHue", h.v)} title={h.label}
                style={{
                  width: 28, height: 28, borderRadius: "var(--sc-r-md)",
                  background: `oklch(0.72 0.15 ${h.v})`,
                  border: tweaks.accentHue === h.v ? "2px solid var(--sc-text)" : "2px solid transparent",
                  cursor: "default",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
                }}/>
            ))}
          </div>
        </div>
      </div>
      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--sc-border)", fontSize: 10.5, color: "var(--sc-text-4)", display: "flex", alignItems: "center", gap: 6 }}>
        <I.Info size={11} /> Persists across reloads
      </div>
    </div>
  );
}

Object.assign(window, { TitleBar, SideNav, TweaksPanel });
