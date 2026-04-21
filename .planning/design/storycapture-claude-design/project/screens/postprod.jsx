/* global React, I, Btn, Badge, Slider, Switch, Segmented, Row, Ph */
// Post-production workspace — scene list (L) + video canvas (C) + inspector (R) + timeline (bottom)

const SCENES = [
  { id: "s1", name: "Landing",   dur: 8.2,  thumbHue: 60,  color: "oklch(0.55 0.14 60)" },
  { id: "s2", name: "Product",   dur: 18.4, thumbHue: 220, color: "oklch(0.55 0.12 220)" },
  { id: "s3", name: "Variant picker", dur: 11.0, thumbHue: 300, color: "oklch(0.55 0.14 300)" },
  { id: "s4", name: "Checkout",  dur: 22.0, thumbHue: 170, color: "oklch(0.55 0.14 170)" },
  { id: "s5", name: "Success",   dur: 6.4,  thumbHue: 120, color: "oklch(0.55 0.14 120)" },
];

const TOTAL = SCENES.reduce((a, s) => a + s.dur, 0);

function SceneList({ selected, onSelect }) {
  return (
    <div style={{ width: 232, borderRight: "1px solid var(--sc-border)", display: "flex", flexDirection: "column", background: "var(--sc-chrome-2)", minHeight: 0 }}>
      <div style={{ padding: "10px 12px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <div className="sc-h">Scenes</div>
        <span style={{ flex: 1 }}/>
        <Btn size="sm" variant="ghost" icon={<I.Plus size={11}/>}/>
      </div>
      <div className="sc-scroll" style={{ flex: 1, padding: "0 8px 8px" }}>
        {SCENES.map((s, i) => {
          const active = s.id === selected;
          return (
            <div key={s.id} onClick={() => onSelect(s.id)}
              style={{
                display: "grid", gridTemplateColumns: "52px 1fr auto", gap: 10,
                padding: 6, marginBottom: 4,
                borderRadius: "var(--sc-r-md)",
                background: active ? "oklch(0.78 0.14 var(--sc-accent-h) / 0.12)" : "transparent",
                border: "1px solid " + (active ? "oklch(0.78 0.14 var(--sc-accent-h) / 0.30)" : "transparent"),
                cursor: "default",
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--sc-hover)"; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
              <div style={{
                aspectRatio: "16/10", borderRadius: 4,
                background: `linear-gradient(135deg, oklch(0.32 0.10 ${s.thumbHue}), oklch(0.18 0.06 ${s.thumbHue}))`,
                border: "1px solid var(--sc-border-2)",
                position: "relative",
              }}>
                <div style={{ position: "absolute", inset: "18% 20%", background: "oklch(0.9 0.004 80)", borderRadius: 1 }}/>
                <div style={{ position: "absolute", top: 2, left: 3, fontSize: 8, color: "rgba(255,255,255,0.6)", fontFamily: "var(--sc-font-mono)" }}>{String(i+1).padStart(2, "0")}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: active ? "var(--sc-accent-300)" : "var(--sc-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                <div style={{ fontSize: 10.5, color: "var(--sc-text-4)", fontFamily: "var(--sc-font-mono)", marginTop: 1 }}>{s.dur.toFixed(1)}s</div>
              </div>
              <div style={{ color: "var(--sc-text-4)", alignSelf: "center" }}><I.MoreH size={12}/></div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: 8, borderTop: "1px solid var(--sc-border)", display: "flex", gap: 6 }}>
        <Btn size="sm" variant="ghost" icon={<I.Plus size={11}/>} style={{ flex: 1, justifyContent: "center" }}>Scene</Btn>
        <Btn size="sm" variant="ghost" icon={<I.Sparkles size={11}/>} style={{ flex: 1, justifyContent: "center" }}>From DSL</Btn>
      </div>
    </div>
  );
}

function VideoCanvas({ time, playing, onTogglePlay }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "var(--sc-n-975)" }}>
      {/* Sub-toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 14px",
        borderBottom: "1px solid var(--sc-border)",
        background: "var(--sc-chrome)",
        height: 40,
      }}>
        <Segmented size="sm" value="fit" onChange={() => {}} options={[
          { value: "fit", label: "Fit" },
          { value: "100", label: "100%" },
          { value: "zoom", label: "Zoom" },
        ]}/>
        <div style={{ width: 1, height: 18, background: "var(--sc-border)" }}/>
        <Btn size="sm" variant="ghost" icon={<I.MousePointer size={12}/>} title="Cursor"/>
        <Btn size="sm" variant="ghost" icon={<I.ZoomIn size={12}/>} title="Add zoom keyframe"/>
        <Btn size="sm" variant="ghost" icon={<I.Sparkles size={12}/>} title="AI auto-zoom"/>
        <Btn size="sm" variant="ghost" icon={<I.Mic size={12}/>} title="Voiceover"/>
        <span style={{ flex: 1 }}/>
        <div style={{ fontSize: 11, color: "var(--sc-text-4)", fontFamily: "var(--sc-font-mono)" }}>
          1920 × 1080 · 60 fps · srgb
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 20, minHeight: 0, position: "relative" }}>
        <div style={{
          width: "min(760px, 95%)",
          aspectRatio: "16/9",
          borderRadius: 6,
          background: `
            radial-gradient(ellipse 40% 60% at 30% 20%, oklch(0.50 0.10 220), transparent 60%),
            linear-gradient(180deg, oklch(0.22 0.05 240), oklch(0.12 0.03 240))`,
          border: "1px solid var(--sc-border-2)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          position: "relative",
          overflow: "hidden",
        }}>
          {/* Fake browser frame — the "recorded" content */}
          <div style={{
            position: "absolute", inset: "5% 6% 5% 6%",
            background: "#fff",
            borderRadius: 6,
            overflow: "hidden",
            display: "flex", flexDirection: "column",
            boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
          }}>
            <div style={{ height: 22, background: "#f3f3f3", display: "flex", alignItems: "center", gap: 4, padding: "0 8px" }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: "#ff5f57"}}/>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: "#febc2e"}}/>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: "#28c840"}}/>
              <div style={{ flex: 1, margin: "0 20px", height: 12, borderRadius: 99, background: "#fff", fontFamily: "var(--sc-font-mono)", fontSize: 9, color: "#777", padding: "0 8px", display: "flex", alignItems: "center" }}>
                acme.test/shop/signature-tote
              </div>
            </div>
            <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", padding: 20, gap: 20 }}>
              <div style={{ background: "linear-gradient(135deg, #fde68a, #fca5a5)", borderRadius: 4 }}/>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#111" }}>Signature tote — oat</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#111", margin: "12px 0" }}>$64.00</div>
                <div style={{ display: "inline-block", background: "#111", color: "#fff", padding: "6px 12px", borderRadius: 3, fontSize: 10, fontWeight: 600 }}>Add to cart</div>
              </div>
            </div>
          </div>

          {/* Zoom keyframe overlay */}
          <div style={{
            position: "absolute", left: "52%", top: "58%",
            width: 160, height: 60,
            border: "2px dashed var(--sc-accent-400)",
            borderRadius: 6,
            pointerEvents: "none",
          }}>
            <div style={{ position: "absolute", top: -18, left: 0, fontSize: 9, fontFamily: "var(--sc-font-mono)", color: "var(--sc-accent-300)", background: "rgba(0,0,0,0.6)", padding: "1px 5px", borderRadius: 3 }}>
              Zoom · k2 · 1.6×
            </div>
            {[[0,0],[1,0],[1,1],[0,1]].map(([x,y], i) => (
              <div key={i} style={{
                position: "absolute",
                left: x ? "100%" : 0, top: y ? "100%" : 0,
                transform: "translate(-50%, -50%)",
                width: 8, height: 8, borderRadius: 99,
                background: "var(--sc-accent-400)", border: "2px solid var(--sc-n-975)",
              }}/>
            ))}
          </div>

          {/* Cursor path trail */}
          <svg width="100%" height="100%" viewBox="0 0 800 450" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <path d="M 120 120 Q 360 90 500 280" stroke="var(--sc-accent-400)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" opacity="0.6"/>
            <circle cx="120" cy="120" r="3" fill="var(--sc-accent-400)"/>
            <circle cx="500" cy="280" r="3" fill="var(--sc-accent-400)"/>
          </svg>

          {/* Safe-area crop guides */}
          <div style={{ position: "absolute", inset: "5% 3% 10% 3%", border: "1px solid rgba(255,255,255,0.08)", pointerEvents: "none" }}/>
        </div>
      </div>

      {/* Transport */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 16px",
        background: "var(--sc-chrome)",
        borderTop: "1px solid var(--sc-border)",
      }}>
        <Btn size="sm" variant="ghost" icon={<I.SkipBack size={12}/>}/>
        <Btn size="sm" variant="primary" icon={playing ? <I.Pause size={11}/> : <I.Play size={11}/>} onClick={onTogglePlay}/>
        <Btn size="sm" variant="ghost" icon={<I.SkipForward size={12}/>}/>
        <div style={{ fontFamily: "var(--sc-font-mono)", fontSize: 12, color: "var(--sc-text-2)", letterSpacing: "0.02em", minWidth: 130 }}>
          <span style={{ color: "var(--sc-text)" }}>{fmt(time)}</span>
          <span style={{ color: "var(--sc-text-4)" }}> / {fmt(TOTAL)}</span>
        </div>
        <div style={{ flex: 1 }}/>
        <Btn size="sm" variant="ghost" icon={<I.Volume size={12}/>}/>
        <Slider value={70} onChange={() => {}} />
        <div style={{ width: 60 }}/>
        <Segmented size="sm" value="1x" onChange={() => {}} options={[
          { value: "0.5x", label: "0.5×" },
          { value: "1x",   label: "1×" },
          { value: "2x",   label: "2×" },
        ]}/>
      </div>
    </div>
  );
}

function fmt(t) {
  const mm = String(Math.floor(t / 60)).padStart(2, "0");
  const ss = String(Math.floor(t % 60)).padStart(2, "0");
  const ff = String(Math.floor((t % 1) * 60)).padStart(2, "0");
  return `${mm}:${ss}:${ff}`;
}

function Inspector({ scene, effects, setEffects }) {
  const [tab, setTab] = React.useState("effects");
  return (
    <div style={{
      width: 300,
      borderLeft: "1px solid var(--sc-border)",
      background: "var(--sc-chrome-2)",
      display: "flex", flexDirection: "column", minHeight: 0,
    }}>
      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--sc-border)", padding: "8px 8px 0" }}>
        {["effects","audio","metadata"].map(t => (
          <div key={t} onClick={() => setTab(t)} style={{
            padding: "6px 10px", fontSize: 12, fontWeight: 500,
            color: tab === t ? "var(--sc-text)" : "var(--sc-text-3)",
            borderBottom: tab === t ? "1.5px solid var(--sc-accent-400)" : "1.5px solid transparent",
            marginBottom: -1,
            textTransform: "capitalize",
            cursor: "default",
          }}>{t}</div>
        ))}
      </div>

      <div className="sc-scroll" style={{ flex: 1, padding: 12 }}>
        {/* Scene block */}
        <div style={{ fontSize: 11, color: "var(--sc-text-4)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 600 }}>Scene</div>
        <div style={{ padding: 10, border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-md)", background: "var(--sc-surface)", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{scene.name}</div>
          <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 2, fontFamily: "var(--sc-font-mono)" }}>
            in 00:08:12 · out 00:26:36 · Δ {scene.dur.toFixed(1)}s
          </div>
        </div>

        {/* Zoom */}
        <InspectorSection title="Auto-zoom" kind={<I.ZoomIn size={11}/>}>
          <Row label="Style">
            <Segmented size="sm" value={effects.zoomStyle} onChange={v => setEffects({...effects, zoomStyle: v})} options={[
              { value: "soft",  label: "Soft" },
              { value: "snap",  label: "Snap" },
              { value: "off",   label: "Off" },
            ]}/>
          </Row>
          <Row label="Strength" hint={`${effects.zoomAmt.toFixed(2)}×`}>
            <Slider value={effects.zoomAmt} min={1} max={2.5} step={0.01} onChange={v => setEffects({...effects, zoomAmt: v})}/>
          </Row>
          <Row label="Ease">
            <Segmented size="sm" value="out" onChange={() => {}} options={[
              { value: "in", label: "In" }, { value: "out", label: "Out" }, { value: "io", label: "InOut" },
            ]}/>
          </Row>
          <Row label="Keyframes">
            <div style={{ display: "flex", gap: 4 }}>
              {[1,2,3,4].map(i => <div key={i} style={{ width: 12, height: 12, transform: "rotate(45deg)", background: "var(--sc-accent-400)", border: "1px solid oklch(0.45 0.12 var(--sc-accent-h))" }}/>)}
              <Btn size="sm" variant="ghost" icon={<I.Plus size={10}/>} style={{ marginLeft: 4, height: 18 }}/>
            </div>
          </Row>
        </InspectorSection>

        {/* Cursor */}
        <InspectorSection title="Cursor" kind={<I.MousePointer size={11}/>}>
          <Row label="Style">
            <Segmented size="sm" value={effects.cursorStyle} onChange={v => setEffects({...effects, cursorStyle: v})} options={[
              { value: "system", label: "System" },
              { value: "dot",    label: "Dot" },
              { value: "halo",   label: "Halo" },
            ]}/>
          </Row>
          <Row label="Path">
            <Segmented size="sm" value="arc" onChange={() => {}} options={[
              { value: "linear", label: "Linear" },
              { value: "arc",    label: "Arc" },
              { value: "spline", label: "Spline" },
            ]}/>
          </Row>
          <Row label="Smoothing" hint={`${Math.round(effects.cursorSmooth*100)}%`}>
            <Slider value={effects.cursorSmooth} min={0} max={1} step={0.01} onChange={v => setEffects({...effects, cursorSmooth: v})}/>
          </Row>
          <Row label="Click emphasis">
            <Switch checked={effects.clickPulse} onChange={v => setEffects({...effects, clickPulse: v})}/>
          </Row>
        </InspectorSection>

        {/* Transitions */}
        <InspectorSection title="Transition" kind={<I.Layers size={11}/>}>
          <Row label="Type">
            <Segmented size="sm" value="fade" onChange={() => {}} options={[
              { value: "cut",  label: "Cut" },
              { value: "fade", label: "Fade" },
              { value: "xf",   label: "Cross" },
            ]}/>
          </Row>
          <Row label="Duration" hint="0.45s">
            <Slider value={45} min={0} max={200} step={5} onChange={() => {}}/>
          </Row>
        </InspectorSection>

        {/* Sound */}
        <InspectorSection title="Sound" kind={<I.Volume size={11}/>}>
          <Row label="Voiceover">
            <div style={{ display: "flex", gap: 4 }}>
              <Badge variant="accent" icon={<I.Mic size={9}/>}>rachel</Badge>
              <Btn size="sm" variant="ghost" icon={<I.ChevronDown size={11}/>}/>
            </div>
          </Row>
          <Row label="Music bed">
            <Segmented size="sm" value="sub" onChange={() => {}} options={[
              { value: "off", label: "Off" },
              { value: "sub", label: "Subtle" },
              { value: "bold", label: "Bold" },
            ]}/>
          </Row>
          <Row label="Duck on VO">
            <Switch checked={true} onChange={() => {}}/>
          </Row>
          <Row label="SFX">
            <Segmented size="sm" value="click" onChange={() => {}} options={[
              { value: "off", label: "Off" },
              { value: "click", label: "Click" },
              { value: "ui", label: "UI" },
            ]}/>
          </Row>
        </InspectorSection>
      </div>
    </div>
  );
}

function InspectorSection({ title, kind, children }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div style={{ marginBottom: 16, border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-md)", overflow: "hidden" }}>
      <div style={{
        padding: "8px 10px", background: "var(--sc-surface-2)",
        display: "flex", alignItems: "center", gap: 8,
        cursor: "default", userSelect: "none",
      }} onClick={() => setOpen(!open)}>
        <span style={{ color: "var(--sc-text-3)" }}>{kind}</span>
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{title}</span>
        {open ? <I.ChevronDown size={11}/> : <I.ChevronRight size={11}/>}
      </div>
      {open && <div style={{ padding: "4px 10px 8px", background: "var(--sc-surface)" }}>{children}</div>}
    </div>
  );
}

function Timeline({ time, setTime, selected, onSelect }) {
  const ref = React.useRef(null);
  const px = 10; // px per second
  const playheadX = time * px + 120; // 120 = left gutter
  const onScrub = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left - 120);
    setTime(Math.max(0, Math.min(TOTAL, x / px)));
  };
  const trackBaseStyle = { height: 32, display: "flex", alignItems: "center", borderBottom: "1px solid var(--sc-border)" };
  const labelStyle = { width: 120, flexShrink: 0, padding: "0 10px", fontSize: 11, color: "var(--sc-text-3)", display: "flex", alignItems: "center", gap: 6, borderRight: "1px solid var(--sc-border)", height: "100%" };

  // Precompute scene positions
  let acc = 0;
  const positions = SCENES.map(s => { const p = { ...s, start: acc, end: acc + s.dur }; acc += s.dur; return p; });

  return (
    <div style={{
      height: 220, borderTop: "1px solid var(--sc-border)",
      background: "var(--sc-chrome-2)",
      display: "flex", flexDirection: "column",
    }}>
      {/* Timeline header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "6px 12px",
        borderBottom: "1px solid var(--sc-border)",
        height: 36, flexShrink: 0,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>Timeline</div>
        <Badge variant="muted">{SCENES.length} clips · {Math.round(TOTAL)}s</Badge>
        <span style={{ flex: 1 }}/>
        <Btn size="sm" variant="ghost" icon={<I.Scissors size={11}/>} title="Split"/>
        <Btn size="sm" variant="ghost" icon={<I.Copy size={11}/>} title="Duplicate"/>
        <Btn size="sm" variant="ghost" icon={<I.Trash size={11}/>} title="Delete"/>
        <div style={{ width: 1, height: 18, background: "var(--sc-border)", margin: "0 4px" }}/>
        <span style={{ fontSize: 11, color: "var(--sc-text-4)", marginRight: 4 }}>Zoom</span>
        <div style={{ width: 90 }}><Slider value={30} onChange={() => {}} accent={false}/></div>
      </div>

      <div ref={ref} className="sc-scroll" style={{ flex: 1, overflowX: "auto", overflowY: "auto", position: "relative", minHeight: 0 }}
        onClick={onScrub}>
        {/* Ruler */}
        <div style={{ display: "flex", height: 22, borderBottom: "1px solid var(--sc-border)", background: "var(--sc-chrome)", position: "sticky", top: 0, zIndex: 3 }}>
          <div style={{ width: 120, flexShrink: 0, padding: "0 10px", fontSize: 10, color: "var(--sc-text-4)", display: "flex", alignItems: "center", borderRight: "1px solid var(--sc-border)" }}>TIME</div>
          <div style={{ flex: 1, position: "relative" }}>
            {Array.from({length: Math.ceil(TOTAL/5)+1}, (_, i) => i * 5).map(t => (
              <div key={t} style={{ position: "absolute", left: t*px, top: 0, bottom: 0, display: "flex", alignItems: "center", borderLeft: "1px solid var(--sc-border)", paddingLeft: 4, fontFamily: "var(--sc-font-mono)", fontSize: 10, color: "var(--sc-text-4)" }}>
                {fmt(t).slice(0,8)}
              </div>
            ))}
          </div>
        </div>

        {/* Video track (clips) */}
        <div style={trackBaseStyle}>
          <div style={labelStyle}><I.Film size={11}/> Video</div>
          <div style={{ flex: 1, position: "relative", height: "100%" }}>
            {positions.map(p => (
              <div key={p.id} onClick={(e) => { e.stopPropagation(); onSelect(p.id); }}
                style={{
                  position: "absolute",
                  left: p.start * px + 2,
                  width: p.dur * px - 4,
                  top: 4, bottom: 4,
                  borderRadius: 3,
                  background: `linear-gradient(180deg, ${p.color}, oklch(0.30 0.08 ${p.thumbHue}))`,
                  border: "1px solid " + (selected === p.id ? "var(--sc-accent-400)" : "oklch(0.45 0.08 " + p.thumbHue + ")"),
                  boxShadow: selected === p.id ? "0 0 0 1px var(--sc-accent-400)" : "none",
                  display: "flex", alignItems: "center",
                  padding: "0 6px", fontSize: 10.5, fontWeight: 500,
                  color: "rgba(255,255,255,0.92)",
                  overflow: "hidden",
                }}>
                <span style={{ whiteSpace: "nowrap" }}>{p.name}</span>
                {/* waveform-like stripes at the base */}
                <div style={{
                  position: "absolute", inset: "auto 0 0 0", height: 10,
                  background: `repeating-linear-gradient(90deg, rgba(255,255,255,0.15) 0 1px, transparent 1px 3px)`,
                  opacity: 0.6,
                }}/>
              </div>
            ))}
          </div>
        </div>

        {/* Zoom keyframes track */}
        <div style={trackBaseStyle}>
          <div style={labelStyle}><I.ZoomIn size={11}/> Zoom</div>
          <div style={{ flex: 1, position: "relative", height: "100%" }}>
            {[6, 14, 22, 30, 42, 52].map((t, i) => (
              <div key={i} style={{
                position: "absolute", left: t * px - 6, top: "50%",
                transform: "translateY(-50%) rotate(45deg)",
                width: 10, height: 10,
                background: "var(--sc-accent-400)",
                border: "1px solid oklch(0.45 0.12 var(--sc-accent-h))",
              }}/>
            ))}
            {/* easing curve */}
            <svg width="100%" height="100%" viewBox={`0 0 ${TOTAL*px} 32`} style={{ position: "absolute", inset: 0 }} preserveAspectRatio="none">
              <path d={`M 0 20 Q ${6*px} 8 ${14*px} 20 Q ${22*px} 8 ${30*px} 20 Q ${42*px} 8 ${52*px} 20`}
                stroke="var(--sc-accent-400)" strokeWidth="1" fill="none" opacity="0.6"/>
            </svg>
          </div>
        </div>

        {/* Cursor path */}
        <div style={trackBaseStyle}>
          <div style={labelStyle}><I.MousePointer size={11}/> Cursor</div>
          <div style={{ flex: 1, position: "relative", height: "100%" }}>
            <svg width="100%" height="32" style={{ position: "absolute", inset: 0 }} preserveAspectRatio="none" viewBox={`0 0 ${TOTAL*px} 32`}>
              <path d={`M 0 16 Q ${8*px} 6 ${14*px} 16 Q ${22*px} 24 ${30*px} 16 L ${42*px} 10 L ${52*px} 18 L ${TOTAL*px} 16`}
                stroke="oklch(0.72 0.14 220)" strokeWidth="1.5" fill="none"/>
            </svg>
            {[2, 14, 22, 30, 38, 46, 58].map((t,i) => (
              <div key={i} style={{ position: "absolute", left: t*px-3, top: "50%", transform: "translateY(-50%)", width: 6, height: 6, borderRadius: 99, background: "oklch(0.72 0.14 220)" }}/>
            ))}
          </div>
        </div>

        {/* Audio track — voiceover */}
        <div style={trackBaseStyle}>
          <div style={labelStyle}><I.Mic size={11}/> VO</div>
          <div style={{ flex: 1, position: "relative", height: "100%" }}>
            {[[1,7],[10,16],[20,28],[34,50]].map(([a,b], i) => (
              <div key={i} style={{
                position: "absolute",
                left: a*px + 2, width: (b-a)*px - 4,
                top: 4, bottom: 4,
                borderRadius: 3,
                background: "oklch(0.35 0.10 170)",
                border: "1px solid oklch(0.45 0.10 170)",
                overflow: "hidden",
              }}>
                {/* waveform */}
                <svg width="100%" height="100%" viewBox="0 0 100 24" preserveAspectRatio="none">
                  {Array.from({length: 80}, (_,j) => {
                    const h = 2 + Math.abs(Math.sin(j * 0.9 + i)) * 8 + Math.abs(Math.cos(j * 0.3)) * 6;
                    return <rect key={j} x={j*1.2} y={12 - h/2} width="0.6" height={h} fill="oklch(0.82 0.14 170)"/>;
                  })}
                </svg>
              </div>
            ))}
          </div>
        </div>

        {/* Music bed */}
        <div style={{ ...trackBaseStyle, borderBottom: "none" }}>
          <div style={labelStyle}><I.Volume size={11}/> Music</div>
          <div style={{ flex: 1, position: "relative", height: "100%" }}>
            <div style={{
              position: "absolute", left: 2, right: 2, top: 4, bottom: 4,
              borderRadius: 3,
              background: "oklch(0.28 0.04 240)",
              border: "1px solid oklch(0.36 0.04 240)",
              overflow: "hidden",
              opacity: 0.85,
            }}>
              <svg width="100%" height="100%" viewBox="0 0 600 24" preserveAspectRatio="none">
                {Array.from({length: 300}, (_,j) => {
                  const h = 3 + Math.abs(Math.sin(j * 0.4)) * 6 + Math.abs(Math.cos(j * 0.12)) * 4;
                  return <rect key={j} x={j*2} y={12 - h/2} width="1" height={h} fill="oklch(0.58 0.08 240)" opacity="0.7"/>;
                })}
              </svg>
            </div>
          </div>
        </div>

        {/* Playhead */}
        <div style={{
          position: "absolute",
          top: 0, bottom: 0,
          left: playheadX,
          width: 1,
          background: "var(--sc-accent-400)",
          zIndex: 4,
          pointerEvents: "none",
        }}>
          <div style={{
            position: "absolute", top: 0, left: -6,
            width: 13, height: 13,
            background: "var(--sc-accent-400)",
            clipPath: "polygon(0 0, 100% 0, 50% 100%)",
          }}/>
        </div>
      </div>
    </div>
  );
}

function PostProdScreen({ empty }) {
  const [selected, setSelected] = React.useState("s2");
  const [time, setTime] = React.useState(12.4);
  const [playing, setPlaying] = React.useState(false);
  const [effects, setEffects] = React.useState({
    zoomStyle: "soft", zoomAmt: 1.6,
    cursorStyle: "halo", cursorSmooth: 0.7, clickPulse: true,
  });
  React.useEffect(() => {
    if (!playing) return;
    const int = setInterval(() => setTime(t => (t >= TOTAL ? 0 : t + 0.1)), 100);
    return () => clearInterval(int);
  }, [playing]);

  if (empty) return <EmptyPostProd/>;

  const scene = SCENES.find(s => s.id === selected) || SCENES[0];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="sc-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Scissors size={14} style={{ color: "var(--sc-text-3)" }}/>
          <div className="sc-toolbar-title">Post-Production</div>
          <Badge variant="muted">checkout_flow · auto-synced</Badge>
        </div>
        <span className="sc-spacer"/>
        <Btn size="sm" variant="ghost" icon={<I.Sparkles size={12}/>}>AI pass</Btn>
        <Btn size="sm" variant="ghost" icon={<I.Eye size={12}/>}>Preview</Btn>
        <Btn size="sm" variant="success" icon={<I.Download size={12}/>}>Export</Btn>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <SceneList selected={selected} onSelect={setSelected}/>
        <VideoCanvas time={time} playing={playing} onTogglePlay={() => setPlaying(p => !p)}/>
        <Inspector scene={scene} effects={effects} setEffects={setEffects}/>
      </div>
      <Timeline time={time} setTime={setTime} selected={selected} onSelect={setSelected}/>
    </div>
  );
}

function EmptyPostProd() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Post-Production</div>
        <span className="sc-spacer"/>
      </div>
      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 40 }}>
        <div style={{ textAlign: "center", maxWidth: 440 }}>
          <div style={{ width: 80, height: 80, margin: "0 auto 20px", borderRadius: 14, background: "var(--sc-surface-2)", border: "1px solid var(--sc-border-2)", display: "grid", placeItems: "center" }}>
            <I.Film size={34} style={{ color: "var(--sc-text-4)" }}/>
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>No capture yet</div>
          <div style={{ fontSize: 12.5, color: "var(--sc-text-3)", lineHeight: 1.5, marginBottom: 20 }}>
            Run your story to produce a capture, then post-production unlocks — auto-zoom, cursor smoothing, transitions, voiceover.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <Btn variant="primary" icon={<I.Record size={11}/>}>Start capture</Btn>
            <Btn icon={<I.FolderOpen size={12}/>}>Open a capture</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PostProdScreen });
