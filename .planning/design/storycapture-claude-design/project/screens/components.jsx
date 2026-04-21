/* global React, I, Btn, Badge, Input, Switch, Segmented, Slider */

function ComponentsScreen({ fireToast }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Components</div>
        <Badge variant="muted">shadcn/ui × Base UI · Vega (New York)</Badge>
        <span className="sc-spacer"/>
      </div>
      <div className="sc-scroll" style={{ flex: 1, padding: "28px 36px" }}>
        <div style={{ maxWidth: 960, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Card title="Buttons">
            <Row2>
              <Btn variant="primary">Primary</Btn>
              <Btn>Default</Btn>
              <Btn variant="ghost">Ghost</Btn>
              <Btn variant="danger" icon={<I.Record size={10}/>}>Record</Btn>
              <Btn variant="success" icon={<I.Download size={11}/>}>Export</Btn>
            </Row2>
            <Row2>
              <Btn size="sm">Small</Btn>
              <Btn size="md">Medium</Btn>
              <Btn size="lg">Large</Btn>
              <Btn size="icon" icon={<I.Plus size={12}/>}/>
              <Btn disabled>Disabled</Btn>
            </Row2>
            <Row2>
              <Btn icon={<I.Play size={11}/>}>Run</Btn>
              <Btn iconRight={<I.ChevronDown size={11}/>}>Share</Btn>
              <Btn variant="primary" icon={<I.Sparkles size={11}/>} kbd="⌘↵">AI pass</Btn>
            </Row2>
          </Card>

          <Card title="Inputs">
            <Input placeholder="Search" icon={<I.Search size={12}/>} kbd="⌘F"/>
            <div style={{ height: 8 }}/>
            <Input placeholder="Project name"/>
            <div style={{ height: 8 }}/>
            <div style={{ display: "flex", gap: 6 }}>
              <Input placeholder="email@team.co" icon={<I.User size={12}/>}/>
              <Btn variant="primary">Invite</Btn>
            </div>
          </Card>

          <Card title="Badges">
            <Row2>
              <Badge>Default</Badge>
              <Badge variant="accent" dot>Active</Badge>
              <Badge variant="success" icon={<I.Check size={9}/>}>Rendered</Badge>
              <Badge variant="record" dot>Recording</Badge>
              <Badge variant="muted">Draft</Badge>
            </Row2>
          </Card>

          <Card title="Switch & Slider">
            <Row2>
              <Switch checked={true} onChange={() => {}}/>
              <Switch checked={false} onChange={() => {}}/>
              <span style={{ fontSize: 12, color: "var(--sc-text-3)" }}>Auto-zoom · Smoothing</span>
            </Row2>
            <div style={{ marginTop: 10 }}><Slider value={60} onChange={() => {}}/></div>
            <div style={{ marginTop: 12 }}><Slider value={30} onChange={() => {}}/></div>
          </Card>

          <Card title="Segmented">
            <Segmented value="1x" onChange={() => {}} options={[
              { value: "0.5x", label: "0.5×" }, { value: "1x", label: "1×" }, { value: "2x", label: "2×" },
            ]}/>
            <div style={{ height: 10 }}/>
            <Segmented size="sm" value="mid" onChange={() => {}} options={[
              { value: "low", label: "Low" }, { value: "mid", label: "Mid" }, { value: "high", label: "High" },
            ]}/>
          </Card>

          <Card title="Timeline track">
            <div style={{ background: "var(--sc-chrome-2)", padding: 8, borderRadius: 6, border: "1px solid var(--sc-border)" }}>
              <div style={{ display: "flex", gap: 4, height: 24, position: "relative" }}>
                {[[0,22,60],[22,48,220],[48,72,300],[72,100,170]].map(([a,b,h],i) => (
                  <div key={i} style={{
                    position: "absolute", left: a+"%", width: (b-a)+"%", top: 0, bottom: 0,
                    background: `linear-gradient(180deg, oklch(0.55 0.14 ${h}), oklch(0.30 0.08 ${h}))`,
                    border: "1px solid oklch(0.45 0.08 "+h+")",
                    borderRadius: 3, fontSize: 10, padding: "3px 5px", color: "rgba(255,255,255,0.9)",
                  }}>clip {i+1}</div>
                ))}
                <div style={{ position: "absolute", left: "36%", top: -4, bottom: -4, width: 1, background: "var(--sc-accent-400)" }}>
                  <div style={{ position: "absolute", top: 0, left: -5, width: 11, height: 11, background: "var(--sc-accent-400)", clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}/>
                </div>
              </div>
            </div>
          </Card>

          <Card title="Command palette row" style={{ gridColumn: "span 2" }}>
            {[
              { i: <I.Home size={13}/>, l: "Go to Projects", k: "⌘1" },
              { i: <I.Record size={13}/>, l: "Start recording", k: "⌘⇧R" },
              { i: <I.Sparkles size={13}/>, l: "Generate captions", k: "" },
            ].map((r, idx) => (
              <div key={idx} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                borderRadius: "var(--sc-r-md)",
                background: idx === 0 ? "var(--sc-hover)" : "transparent",
                fontSize: 13,
              }}>
                <span style={{ color: "var(--sc-text-3)" }}>{r.i}</span>
                <span style={{ flex: 1 }}>{r.l}</span>
                {r.k && <span className="sc-kbd">{r.k}</span>}
              </div>
            ))}
          </Card>

          <Card title="Toast preview" style={{ gridColumn: "span 2" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Btn onClick={() => fireToast?.({ kind: "success", title: "Render complete", desc: "checkout-flow-v3.mp4 · 18.4 MB", actions: [{ label: "Reveal" }] })}>Success</Btn>
              <Btn onClick={() => fireToast?.({ kind: "error", title: "Capture failed", desc: "SCK permission denied. Open System Settings." })}>Error</Btn>
              <Btn onClick={() => fireToast?.({ kind: "info", title: "New scene linked", desc: "scene \"checkout\" auto-generated from DSL." })}>Info</Btn>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children, style }) {
  return (
    <div className="sc-card" style={{ padding: 16, ...style }}>
      <div className="sc-h" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
function Row2({ children }) {
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>{children}</div>;
}

Object.assign(window, { ComponentsScreen });
