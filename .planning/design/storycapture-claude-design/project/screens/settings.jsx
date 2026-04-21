/* global React, I, Btn, Badge, Input, Switch, Segmented, Row */

function SettingsScreen() {
  const [section, setSection] = React.useState("keys");
  const sections = [
    { id: "general", label: "General", icon: <I.Settings size={12}/> },
    { id: "keys",    label: "API keys", icon: <I.Key size={12}/> },
    { id: "capture", label: "Capture backend", icon: <I.Monitor size={12}/> },
    { id: "render",  label: "Render defaults", icon: <I.Download size={12}/> },
    { id: "kbd",     label: "Keyboard", icon: <I.Keyboard size={12}/> },
    { id: "privacy", label: "Privacy & telemetry", icon: <I.Lock size={12}/> },
    { id: "about",   label: "About", icon: <I.Info size={12}/> },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Settings</div>
        <Badge variant="muted">Workspace · Eleanor Walsh</Badge>
        <span className="sc-spacer"/>
        <Btn size="sm" variant="ghost">Reset to defaults</Btn>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ width: 200, borderRight: "1px solid var(--sc-border)", background: "var(--sc-chrome-2)", padding: "10px 0" }}>
          {sections.map(s => (
            <div key={s.id} onClick={() => setSection(s.id)} className={`sc-nav-item ${section === s.id ? "active" : ""}`}
              style={{ fontSize: 12 }}>
              <span style={{ width: 14, display: "grid", placeItems: "center", color: section === s.id ? "var(--sc-accent-400)" : "var(--sc-text-3)" }}>{s.icon}</span>
              {s.label}
            </div>
          ))}
        </div>
        <div className="sc-scroll" style={{ flex: 1, padding: "24px 32px" }}>
          {section === "keys" && <SettingsKeys/>}
          {section === "capture" && <SettingsCapture/>}
          {section === "privacy" && <SettingsPrivacy/>}
          {section === "general" && <SettingsGeneral/>}
          {section === "render" && <SettingsRender/>}
          {section === "kbd" && <SettingsKbd/>}
          {section === "about" && <SettingsAbout/>}
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ title, desc, children }) {
  return (
    <div style={{ maxWidth: 620 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {desc && <div style={{ fontSize: 12.5, color: "var(--sc-text-3)", marginBottom: 20, lineHeight: 1.5 }}>{desc}</div>}
      <div>{children}</div>
    </div>
  );
}

function KeyRow({ provider, sub, stored, icon }) {
  const [val, setVal] = React.useState(stored ? "sk-•••••••••••••••••••••••••••••••" : "");
  const [show, setShow] = React.useState(false);
  return (
    <div style={{ padding: "14px 0", borderBottom: "1px solid var(--sc-border)", display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 16, alignItems: "center" }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>{icon} {provider}</div>
        <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 2 }}>{sub}</div>
      </div>
      <div>
        <Input value={show ? "sk-proj-x8D3jfHk2…xvQm" : val} onChange={e => setVal(e.target.value)}
          type={show ? "text" : "password"}
          placeholder="Paste key…"
          icon={<I.Key size={12}/>}/>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <Btn size="sm" variant="ghost" icon={show ? <I.EyeOff size={12}/> : <I.Eye size={12}/>} onClick={() => setShow(s => !s)}/>
        {stored ? <Badge variant="success" dot>Keychain</Badge> : <Badge variant="muted">Unset</Badge>}
      </div>
    </div>
  );
}

function SettingsKeys() {
  return (
    <SettingsPanel title="API keys"
      desc="Keys are stored in the OS keychain (Keychain on macOS, Credential Manager on Windows). StoryCapture never sends them to its own servers.">
      <div style={{ border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-lg)", background: "var(--sc-surface)", padding: "0 16px" }}>
        <KeyRow provider="OpenAI" sub="Narration transcripts, scene summaries" stored icon={<span style={{ width: 8, height: 8, borderRadius: 99, background: "oklch(0.72 0.14 170)" }}/>}/>
        <KeyRow provider="Anthropic" sub="DSL assist, lint suggestions" stored icon={<span style={{ width: 8, height: 8, borderRadius: 99, background: "oklch(0.72 0.14 30)" }}/>}/>
        <KeyRow provider="ElevenLabs" sub="Voice synthesis for narrate() directives" stored icon={<span style={{ width: 8, height: 8, borderRadius: 99, background: "oklch(0.72 0.14 300)" }}/>}/>
        <KeyRow provider="Azure Speech" sub="Backup voice provider" icon={<span style={{ width: 8, height: 8, borderRadius: 99, background: "oklch(0.72 0.14 240)" }}/>}/>
      </div>
      <div style={{ marginTop: 16, padding: 12, background: "oklch(0.78 0.14 var(--sc-accent-h) / 0.08)", border: "1px solid oklch(0.78 0.14 var(--sc-accent-h) / 0.2)", borderRadius: "var(--sc-r-md)", display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12, color: "var(--sc-text-2)" }}>
        <I.Info size={14} style={{ color: "var(--sc-accent-400)", marginTop: 1 }}/>
        <div>
          <b style={{ color: "var(--sc-accent-300)" }}>Team BYOK</b> — workspace admins can share keys scoped by scene type. <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>Configure team keys →</span>
        </div>
      </div>
    </SettingsPanel>
  );
}

function SettingsCapture() {
  const [backend, setBackend] = React.useState("sck");
  return (
    <SettingsPanel title="Capture backend"
      desc="StoryCapture records your scripted browser session. Pick the backend best suited to your OS; fall-through is automatic on failure.">
      <div style={{ display: "grid", gap: 10 }}>
        {[
          { id: "sck", name: "ScreenCaptureKit", sub: "macOS 12.3+ · 60 fps · hardware cursor · recommended", os: "macOS", badge: "recommended" },
          { id: "wgc", name: "Windows Graphics Capture", sub: "Windows 10 2004+ · zero-copy via DX11", os: "Windows" },
          { id: "xcap", name: "xcap (cross-platform)", sub: "Fallback when native APIs unavailable · 30–60 fps", os: "Fallback" },
        ].map(b => (
          <div key={b.id} onClick={() => setBackend(b.id)}
            style={{
              padding: 14, border: "1px solid " + (backend === b.id ? "var(--sc-accent-400)" : "var(--sc-border)"),
              borderRadius: "var(--sc-r-md)", background: "var(--sc-surface)", cursor: "default",
              display: "grid", gridTemplateColumns: "16px 1fr auto", gap: 12, alignItems: "center",
              boxShadow: backend === b.id ? "0 0 0 3px var(--sc-focus-ring)" : "none",
            }}>
            <div style={{
              width: 14, height: 14, borderRadius: 99,
              border: "1.5px solid " + (backend === b.id ? "var(--sc-accent-400)" : "var(--sc-border-strong)"),
              display: "grid", placeItems: "center",
            }}>
              {backend === b.id && <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--sc-accent-400)" }}/>}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--sc-text-4)", marginTop: 2 }}>{b.sub}</div>
            </div>
            <Badge variant={b.badge ? "accent" : "muted"}>{b.os}</Badge>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-lg)", background: "var(--sc-surface)" }}>
        <div style={{ padding: "0 16px" }}>
          <Row label="Capture fps" hint="Target. Falls back at playback time.">
            <Segmented size="sm" value="60" onChange={() => {}} options={[
              { value: "30", label: "30" }, { value: "60", label: "60" }, { value: "120", label: "120" },
            ]}/>
          </Row>
          <Row label="Capture cursor" hint="Real cursor vs. synthesized path">
            <Switch checked={false} onChange={() => {}}/>
          </Row>
          <Row label="Color space">
            <Segmented size="sm" value="srgb" onChange={() => {}} options={[
              { value: "srgb", label: "sRGB" },
              { value: "p3", label: "Display P3" },
              { value: "rec709", label: "Rec.709" },
            ]}/>
          </Row>
          <Row label="Audio input">
            <Segmented size="sm" value="sys" onChange={() => {}} options={[
              { value: "off", label: "Off" }, { value: "sys", label: "System" }, { value: "mic", label: "Mic" },
            ]}/>
          </Row>
        </div>
      </div>
    </SettingsPanel>
  );
}

function SettingsPrivacy() {
  return (
    <SettingsPanel title="Privacy & telemetry"
      desc="Telemetry is off by default. Nothing about your stories, prompts, or recordings leaves your machine unless you explicitly share.">
      <div style={{ border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-lg)", background: "var(--sc-surface)", padding: "0 16px" }}>
        <Row label="Crash reports" hint="Anonymized stack traces only"><Switch checked={false} onChange={() => {}}/></Row>
        <Row label="Usage analytics" hint="Feature counts; no content"><Switch checked={false} onChange={() => {}}/></Row>
        <Row label="Auto-update" hint="Checks on launch once per day"><Switch checked={true} onChange={() => {}}/></Row>
        <Row label="Prompt redaction" hint="Strip values from .story before sending to LLM"><Switch checked={true} onChange={() => {}}/></Row>
      </div>
      <div style={{ marginTop: 16, padding: 14, background: "var(--sc-surface-2)", border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-md)", fontSize: 12, color: "var(--sc-text-3)", lineHeight: 1.5 }}>
        You can <span style={{ color: "var(--sc-accent-400)", textDecoration: "underline", textUnderlineOffset: 2 }}>export a diagnostic bundle</span> at any time. All bundles are signed with your key and never auto-uploaded.
      </div>
    </SettingsPanel>
  );
}

function SettingsGeneral() {
  return (
    <SettingsPanel title="General">
      <div style={{ border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-lg)", background: "var(--sc-surface)", padding: "0 16px" }}>
        <Row label="Projects folder">
          <Input value="~/Documents/StoryCapture" icon={<I.FolderOpen size={12}/>} onChange={() => {}}/>
        </Row>
        <Row label="Startup"><Segmented size="sm" value="last" onChange={() => {}} options={[
          { value: "welcome", label: "Welcome" }, { value: "last", label: "Last project" }, { value: "new", label: "New story" },
        ]}/></Row>
        <Row label="Auto-save" hint="Every 12 seconds"><Switch checked={true} onChange={() => {}}/></Row>
        <Row label="Dock badge" hint="Show render progress on dock icon"><Switch checked={true} onChange={() => {}}/></Row>
      </div>
    </SettingsPanel>
  );
}

function SettingsRender() {
  return (
    <SettingsPanel title="Render defaults">
      <div style={{ border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-lg)", background: "var(--sc-surface)", padding: "0 16px" }}>
        <Row label="Resolution"><Segmented size="sm" value="1080p" onChange={() => {}} options={[
          { value: "720p", label: "720" }, { value: "1080p", label: "1080" }, { value: "1440p", label: "1440" }, { value: "4k", label: "4K" },
        ]}/></Row>
        <Row label="Codec"><Segmented size="sm" value="h264" onChange={() => {}} options={[
          { value: "h264", label: "H.264" }, { value: "hevc", label: "HEVC" }, { value: "prores", label: "ProRes" },
        ]}/></Row>
        <Row label="HW encoder"><Switch checked={true} onChange={() => {}}/></Row>
        <Row label="Parallel renders" hint="Cap background jobs"><Slider value={2} min={1} max={6} step={1} onChange={() => {}}/></Row>
      </div>
    </SettingsPanel>
  );
}

function SettingsKbd() {
  const rows = [
    ["Record",          "⌘ ⇧ R"],
    ["Run scene",       "⌘ ↵"],
    ["Split clip",      "⌘ K"],
    ["Command palette", "⌘ K"],
    ["Toggle preview",  "⌘ ."],
    ["New story",       "⌘ N"],
    ["Open project",    "⌘ O"],
    ["Export",          "⌘ E"],
  ];
  return (
    <SettingsPanel title="Keyboard shortcuts">
      <div style={{ border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-lg)", background: "var(--sc-surface)" }}>
        {rows.map(([l, k], i) => (
          <div key={l} style={{ display: "flex", padding: "10px 16px", borderBottom: i < rows.length-1 ? "1px solid var(--sc-border)" : "none", fontSize: 12.5 }}>
            <span style={{ flex: 1 }}>{l}</span>
            <span className="sc-kbd">{k}</span>
          </div>
        ))}
      </div>
    </SettingsPanel>
  );
}

function SettingsAbout() {
  return (
    <SettingsPanel title="About">
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: 16, border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-lg)", background: "var(--sc-surface)" }}>
        <div className="sc-brand-mark" style={{ width: 48, height: 48, borderRadius: 12 }}/>
        <div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>StoryCapture</div>
          <div style={{ fontSize: 12, color: "var(--sc-text-4)", marginTop: 2, fontFamily: "var(--sc-font-mono)" }}>v0.4.2 · tauri 2.1 · rustc 1.78</div>
          <div style={{ fontSize: 12, color: "var(--sc-text-3)", marginTop: 8 }}>DSL → polished demo videos. Built for teams who ship demos daily.</div>
        </div>
      </div>
    </SettingsPanel>
  );
}

Object.assign(window, { SettingsScreen });
