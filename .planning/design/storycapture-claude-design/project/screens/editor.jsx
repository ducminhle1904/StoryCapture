/* global React, I, Btn, Badge, Input, Segmented, Ph */
// Story editor — DSL editor (left) + live browser preview (right) + run controls
const DEFAULT_DSL = `# Checkout flow — v3
# Target: https://acme.test/shop
# Duration target: ~80s

story "Checkout flow" {
  viewport  1440 x 900
  voice     elevenlabs.rachel
  theme     light
}

scene "landing" {
  navigate  "https://acme.test/shop"
  wait      page.ready
  narrate   "Our shop loads in under 200 milliseconds, with zero layout shift."
  zoom      selector=".hero-cta" duration=1.2 ease=out
  cursor    to=".hero-cta" path=arc
  click     ".hero-cta"
  transition fade 0.3
}

scene "product" {
  wait      selector=".product-title"
  narrate   "Customers pick a variant — we track the interaction across devices."
  hover     ".variant-selector" hold=0.6
  click     ".variant-selector [data-size='M']"
  zoom      selector=".price" duration=0.9
  type      ".qty" text="2" speed=natural
  click     "button.add-to-cart"
  sound     "chime.mp3" volume=0.4
}

scene "checkout" {
  click     ".cart-icon"
  wait      page.stable
  narrate   "Stripe-powered checkout, autofilled from their session."
  highlight ".shipping"
  type      "input[name='email']" text="ellie@acme.test"
  type      "input[name='card']"  text="4242 4242 4242 4242" speed=fast
  click     "button[type='submit']"
  zoom      selector=".success-banner" duration=1.5
  transition crossfade 0.5
}
`;

const TOKENS = [
  { r: /^(\s*#.*)$/gm,                       c: "var(--sc-text-4)", style: "italic" },
  { r: /\b(story|scene|viewport|voice|theme)\b/g, c: "oklch(0.78 0.14 var(--sc-accent-h))" },
  { r: /\b(navigate|click|type|hover|wait|zoom|cursor|narrate|transition|sound|highlight)\b/g, c: "oklch(0.75 0.14 220)" },
  { r: /\b(duration|ease|path|speed|hold|volume|selector|text|to|out)\b/g, c: "oklch(0.70 0.10 280)" },
  { r: /"([^"]*)"/g,                         c: "oklch(0.78 0.10 140)" },
  { r: /\b(\d+(?:\.\d+)?)\b/g,               c: "oklch(0.78 0.12 60)" },
  { r: /([{}=])/g,                           c: "var(--sc-text-3)" },
];

function highlightLine(line) {
  // naive tokenizer — produce an HTML string
  let html = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  TOKENS.forEach(t => {
    html = html.replace(t.r, (m) => `<span style="color:${t.c};${t.style ? `font-style:${t.style};`:""}">${m}</span>`);
  });
  return html;
}

function DSLEditor({ value, onChange, cursorLine }) {
  const lines = value.split("\n");
  const taRef = React.useRef(null);
  const hlRef = React.useRef(null);
  const gutterRef = React.useRef(null);
  const onScroll = () => {
    if (!hlRef.current || !taRef.current) return;
    hlRef.current.scrollTop = taRef.current.scrollTop;
    hlRef.current.scrollLeft = taRef.current.scrollLeft;
    if (gutterRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
  };
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "44px 1fr",
      flex: 1, minHeight: 0, position: "relative",
      fontFamily: "var(--sc-font-mono)", fontSize: 12.5, lineHeight: "20px",
      background: "var(--sc-surface)",
    }}>
      {/* Gutter */}
      <div ref={gutterRef} style={{
        background: "var(--sc-surface)",
        borderRight: "1px solid var(--sc-border)",
        overflow: "hidden",
        padding: "12px 0",
        userSelect: "none",
      }}>
        {lines.map((l, i) => {
          const n = i + 1;
          const active = n === cursorLine;
          // Fake "lint" markers on a couple lines
          const lint = (n === 24) ? "warn" : (n === 34) ? "info" : null;
          return (
            <div key={i} style={{
              height: 20,
              display: "flex", alignItems: "center", justifyContent: "flex-end",
              paddingRight: 8,
              color: active ? "var(--sc-text)" : "var(--sc-text-4)",
              background: active ? "oklch(0.78 0.14 var(--sc-accent-h) / 0.08)" : "transparent",
              fontVariantNumeric: "tabular-nums",
              fontSize: 11,
            }}>
              {lint && (
                <span style={{
                  width: 6, height: 6, borderRadius: 99,
                  background: lint === "warn" ? "var(--sc-warn)" : "var(--sc-info)",
                  marginRight: 6,
                }}/>
              )}
              {n}
            </div>
          );
        })}
      </div>

      {/* Editor */}
      <div style={{ position: "relative", overflow: "hidden" }}>
        {/* Highlight layer */}
        <pre ref={hlRef} aria-hidden="true" style={{
          margin: 0, padding: "12px 16px",
          position: "absolute", inset: 0,
          overflow: "auto",
          whiteSpace: "pre",
          color: "var(--sc-text-2)",
          fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit",
          pointerEvents: "none",
        }}>
          {lines.map((l, i) => {
            const active = i + 1 === cursorLine;
            return (
              <div key={i} style={{
                background: active ? "oklch(0.78 0.14 var(--sc-accent-h) / 0.08)" : "transparent",
                marginLeft: -16, paddingLeft: 16, marginRight: -16, paddingRight: 16,
              }} dangerouslySetInnerHTML={{ __html: highlightLine(l) || "&nbsp;" }}/>
            );
          })}
        </pre>
        {/* Actual textarea (transparent text, real caret) */}
        <textarea ref={taRef} value={value} onChange={e => onChange(e.target.value)} onScroll={onScroll}
          spellCheck={false}
          style={{
            position: "absolute", inset: 0,
            width: "100%", height: "100%",
            background: "transparent", color: "transparent",
            caretColor: "var(--sc-accent-400)",
            border: "none", outline: "none", resize: "none",
            padding: "12px 16px",
            fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit",
            whiteSpace: "pre",
          }}/>
      </div>
    </div>
  );
}

function BrowserMock({ url = "https://acme.test/shop", recording, running }) {
  return (
    <div style={{
      flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
      background: "var(--sc-surface)",
      borderLeft: "1px solid var(--sc-border)",
      position: "relative",
    }}>
      {/* Fake chrome */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px",
        background: "var(--sc-surface-2)",
        borderBottom: "1px solid var(--sc-border)",
      }}>
        <div style={{ display: "flex", gap: 4 }}>
          <I.ChevronRight size={14} style={{ transform: "scaleX(-1)", color: "var(--sc-text-4)" }}/>
          <I.ChevronRight size={14} style={{ color: "var(--sc-text-4)" }}/>
        </div>
        <div style={{
          flex: 1, height: 24, borderRadius: 999,
          background: "var(--sc-surface)", border: "1px solid var(--sc-border)",
          display: "flex", alignItems: "center", gap: 6, padding: "0 10px",
          fontSize: 11.5, color: "var(--sc-text-3)",
          fontFamily: "var(--sc-font-mono)",
        }}>
          <I.Lock size={10}/> {url}
        </div>
        <div style={{ display: "flex", gap: 4, color: "var(--sc-text-4)" }}>
          <I.MoreH size={14}/>
        </div>
      </div>

      {/* Fake page */}
      <div style={{ flex: 1, background: "#fff", position: "relative", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "12px 24px", borderBottom: "1px solid #eee", gap: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#222" }}>acme</div>
          <div style={{ display: "flex", gap: 14, fontSize: 11, color: "#666" }}>
            <span>Shop</span><span>Collections</span><span>About</span>
          </div>
          <span style={{ flex: 1 }}/>
          <div style={{ width: 140, height: 20, borderRadius: 99, background: "#f3f3f3" }}/>
          <div style={{ width: 18, height: 18, borderRadius: 99, background: "#e8e8e8" }}/>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: 30, gap: 30 }}>
          <div style={{ aspectRatio: "1", background: "linear-gradient(135deg, #fde68a, #fca5a5)", borderRadius: 8 }}/>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#111", lineHeight: 1.1 }}>Signature tote — oat</div>
            <div style={{ fontSize: 13, color: "#888", margin: "8px 0 16px" }}>Cotton canvas · Made in Portugal</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#111", marginBottom: 16 }}>$64.00</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {["S", "M", "L"].map((s, i) => (
                <div key={s} style={{
                  width: 32, height: 32, borderRadius: 99,
                  background: i === 1 ? "#111" : "#fff",
                  color: i === 1 ? "#fff" : "#333",
                  border: "1px solid #ddd",
                  display: "grid", placeItems: "center",
                  fontSize: 11, fontWeight: 600,
                }}>{s}</div>
              ))}
            </div>
            <div style={{
              display: "inline-flex", gap: 10, alignItems: "center",
              background: "#111", color: "#fff",
              padding: "10px 18px", borderRadius: 6, fontSize: 12, fontWeight: 600,
              position: "relative",
            }} className="preview-cta">
              Add to cart — $64.00
              {running && (
                <div style={{
                  position: "absolute", inset: -4, border: "2px solid var(--sc-accent-400)",
                  borderRadius: 8, pointerEvents: "none",
                  animation: "sc-pulse 1.2s ease-in-out infinite",
                }}/>
              )}
            </div>
          </div>
        </div>

        {/* Simulated cursor animation */}
        {running && (
          <div style={{
            position: "absolute",
            left: "55%", top: "68%",
            transition: "all 2s cubic-bezier(0.4, 0, 0.2, 1)",
            pointerEvents: "none",
          }}>
            <svg width="20" height="20" viewBox="0 0 20 20">
              <path d="M3 2l5 14 2-6 6-2z" fill="#fff" stroke="#111" strokeWidth="1"/>
            </svg>
          </div>
        )}

        {/* Zoom frame overlay */}
        {running && (
          <div style={{
            position: "absolute",
            left: "47%", top: "62%",
            width: 230, height: 52,
            border: "2px solid var(--sc-accent-400)",
            borderRadius: 8,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.3)",
            pointerEvents: "none",
            animation: "sc-fade-in 0.3s ease-out",
          }}>
            <div style={{
              position: "absolute", top: -22, left: 0,
              fontFamily: "var(--sc-font-mono)", fontSize: 10, color: "#fff",
              background: "var(--sc-accent-500)", padding: "1px 6px", borderRadius: 3,
            }}>ZOOM · 1.8×</div>
          </div>
        )}
      </div>

      {/* Bottom status strip */}
      <div style={{
        padding: "6px 12px",
        borderTop: "1px solid var(--sc-border)",
        background: "var(--sc-surface-2)",
        display: "flex", alignItems: "center", gap: 10,
        fontSize: 11, color: "var(--sc-text-3)",
        fontFamily: "var(--sc-font-mono)",
      }}>
        <Badge variant={running ? "record" : "muted"} dot>{running ? "Running" : "Idle"}</Badge>
        <span>1440 × 900</span>
        <span>·</span>
        <span>Chromium 125</span>
        <span>·</span>
        <span>SCK capture</span>
        <span style={{ flex: 1 }}/>
        <span>60 fps</span>
      </div>
    </div>
  );
}

function ConsoleStrip({ running }) {
  return (
    <div style={{
      height: 140,
      borderTop: "1px solid var(--sc-border)",
      background: "var(--sc-surface)",
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 12px", borderBottom: "1px solid var(--sc-border)",
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--sc-text-2)" }}>Console</div>
        <Badge variant="muted" dot>14 events</Badge>
        <Badge variant="record">1 warning</Badge>
        <span style={{ flex: 1 }}/>
        <Btn size="sm" variant="ghost" icon={<I.Trash size={11}/>}>Clear</Btn>
      </div>
      <div className="sc-scroll" style={{ flex: 1, padding: "4px 12px", fontFamily: "var(--sc-font-mono)", fontSize: 11.5, lineHeight: "18px" }}>
        {[
          { t: "00.00", k: "info", m: "scene \"landing\" started" },
          { t: "00.12", k: "info", m: "navigate → acme.test/shop (312 ms)" },
          { t: "00.44", k: "info", m: "wait page.ready → ok (144 ms)" },
          { t: "00.58", k: "success", m: "narrate queued · 7.2s · elevenlabs.rachel" },
          { t: "01.80", k: "info", m: "zoom .hero-cta → 1.8× in 1.2s" },
          { t: "03.02", k: "warn", m: "cursor path=arc · fallback to linear on headless" },
          { t: "03.20", k: "info", m: "click .hero-cta → target matched (1)" },
          { t: "03.55", k: "info", m: "transition fade 0.3s" },
          { t: "03.85", k: "info", m: "scene \"product\" started" },
        ].map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "48px 12px 1fr", gap: 8 }}>
            <span style={{ color: "var(--sc-text-4)" }}>{r.t}</span>
            <span style={{ color: r.k === "warn" ? "var(--sc-warn)" : r.k === "success" ? "var(--sc-success)" : "var(--sc-text-4)" }}>{r.k === "warn" ? "!" : r.k === "success" ? "✓" : "·"}</span>
            <span style={{ color: "var(--sc-text-2)" }}>{r.m}</span>
          </div>
        ))}
        {running && (
          <div style={{ display: "grid", gridTemplateColumns: "48px 12px 1fr", gap: 8, color: "var(--sc-accent-400)" }}>
            <span>─</span><span>▸</span><span>running scene 2/4…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EditorScreen({ recording, onRecord, onOpenExport }) {
  const [dsl, setDsl] = React.useState(DEFAULT_DSL);
  const [running, setRunning] = React.useState(false);
  const [cursorLine, setCursorLine] = React.useState(17);
  React.useEffect(() => {
    if (!running) return;
    const int = setInterval(() => setCursorLine(c => (c >= 40 ? 10 : c + 1)), 400);
    return () => clearInterval(int);
  }, [running]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Toolbar */}
      <div className="sc-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.FolderOpen size={14} style={{ color: "var(--sc-text-3)" }}/>
          <span style={{ fontSize: 12.5, color: "var(--sc-text-3)" }}>checkout-flow</span>
          <I.ChevronRight size={10} style={{ color: "var(--sc-text-4)" }}/>
          <span style={{ fontSize: 13, fontWeight: 600 }}>checkout_flow.story</span>
          <Badge variant="muted">modified</Badge>
        </div>
        <span className="sc-spacer"/>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <Badge variant="muted" icon={<I.Check size={10}/>}>Lint clean</Badge>
          <div style={{ width: 1, height: 18, background: "var(--sc-border)", margin: "0 4px" }}/>
          <Btn size="sm" variant="ghost" icon={<I.SkipBack size={11}/>} title="Prev scene"/>
          <Btn size="sm" variant={running ? "default" : "primary"} icon={running ? <I.Pause size={11}/> : <I.Play size={11}/>} onClick={() => setRunning(r => !r)}>
            {running ? "Pause" : "Run"}
          </Btn>
          <Btn size="sm" variant="ghost" icon={<I.SkipForward size={11}/>} title="Next scene"/>
          <div style={{ width: 1, height: 18, background: "var(--sc-border)", margin: "0 4px" }}/>
          <Btn size="sm" variant={recording ? "danger" : "default"} icon={recording ? <I.Stop size={11}/> : <I.Record size={10}/>} onClick={onRecord}>
            {recording ? "Stop" : "Record"}
          </Btn>
          <Btn size="sm" variant="success" icon={<I.Download size={11}/>} onClick={onOpenExport}>Export</Btn>
        </div>
      </div>

      {/* Split */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", flex: 1, minHeight: 0 }}>
        {/* Left — editor */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--sc-border)" }}>
          {/* Tabs */}
          <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--sc-border)", background: "var(--sc-chrome-2)", height: 32, paddingLeft: 8 }}>
            {["checkout_flow.story", "helpers.story"].map((t, i) => (
              <div key={t} style={{
                padding: "0 12px", height: "100%",
                display: "inline-flex", alignItems: "center", gap: 6,
                background: i === 0 ? "var(--sc-surface)" : "transparent",
                borderRight: "1px solid var(--sc-border)",
                fontSize: 12, color: i === 0 ? "var(--sc-text)" : "var(--sc-text-3)",
                borderTop: i === 0 ? "1.5px solid var(--sc-accent-400)" : "1.5px solid transparent",
                fontFamily: "var(--sc-font-mono)",
              }}>
                <I.File size={11}/> {t}
                <I.X size={11} style={{ opacity: 0.4, marginLeft: 4 }}/>
              </div>
            ))}
            <Btn size="sm" variant="ghost" icon={<I.Plus size={11}/>} style={{ marginLeft: 4 }}/>
            <span style={{ flex: 1 }}/>
            <div style={{ fontSize: 11, color: "var(--sc-text-4)", padding: "0 10px", fontFamily: "var(--sc-font-mono)" }}>
              Ln {cursorLine}, Col 3 · SC-DSL · UTF-8
            </div>
          </div>
          <DSLEditor value={dsl} onChange={setDsl} cursorLine={cursorLine}/>
          <ConsoleStrip running={running}/>
        </div>

        {/* Right — preview */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "0 12px", height: 32,
            borderBottom: "1px solid var(--sc-border)",
            background: "var(--sc-chrome-2)",
          }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Live Preview</div>
            <Badge variant="muted" dot>{running ? "playing" : "paused"}</Badge>
            <span style={{ flex: 1 }}/>
            <Segmented size="sm" value="dsktop" onChange={() => {}} options={[
              { value: "mob", label: "Mobile" },
              { value: "tab", label: "Tablet" },
              { value: "dsktop", label: "Desktop" },
            ]}/>
            <Btn size="sm" variant="ghost" icon={<I.Maximize size={12}/>}/>
          </div>
          <BrowserMock running={running} recording={recording}/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { EditorScreen });
