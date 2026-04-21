/* global React, I, Btn, Badge, Input, Switch, Segmented, Slider, Ph */

function TokensScreen() {
  const neutrals = [
    "975","950","925","900","850","800","700","600","500","400","300","200","100","50","25","0"
  ].map(k => ({ k, v: `var(--sc-n-${k})` }));
  const accents = [
    "100","200","300","400","500","600","700"
  ].map(k => ({ k, v: `var(--sc-accent-${k})` }));
  const sem = [
    { k: "record",  v: "var(--sc-record)",  label: "Record / destructive" },
    { k: "success", v: "var(--sc-success)", label: "Success / export" },
    { k: "warn",    v: "var(--sc-warn)",    label: "Warn" },
    { k: "info",    v: "var(--sc-info)",    label: "Info" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Design Tokens</div>
        <Badge variant="muted">Tailwind v4 @theme · CSS variables</Badge>
        <span className="sc-spacer"/>
        <Btn size="sm" variant="ghost" icon={<I.Copy size={12}/>}>Copy as CSS</Btn>
      </div>
      <div className="sc-scroll" style={{ flex: 1, padding: "28px 36px" }}>
        <div style={{ maxWidth: 960 }}>
          <H2>Neutral ramp</H2>
          <P>Cool-leaning grays with a subtle warm bias (hue 80, chroma 0.008). Dark-first; light mode remaps the same tokens.</P>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 4, marginBottom: 8 }}>
            {neutrals.map(n => (
              <div key={n.k}>
                <div style={{ height: 56, background: n.v, borderRadius: 4, border: "1px solid var(--sc-border)" }}/>
                <div style={{ fontSize: 10, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-4)", marginTop: 4, textAlign: "center" }}>{n.k}</div>
              </div>
            ))}
          </div>

          <H2 style={{ marginTop: 40 }}>Accent — warm amber</H2>
          <P>Configurable at runtime by the <code style={{ fontFamily: "var(--sc-font-mono)", fontSize: 11, background: "var(--sc-surface-2)", padding: "1px 5px", borderRadius: 3 }}>--sc-accent-h</code> variable. Used for selection, focus, keyframes.</P>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
            {accents.map(a => (
              <div key={a.k}>
                <div style={{ height: 72, background: a.v, borderRadius: 6 }}/>
                <div style={{ fontSize: 11, fontFamily: "var(--sc-font-mono)", marginTop: 6 }}>accent-{a.k}</div>
              </div>
            ))}
          </div>

          <H2 style={{ marginTop: 40 }}>Semantic</H2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {sem.map(s => (
              <div key={s.k} className="sc-card" style={{ padding: 10 }}>
                <div style={{ height: 44, background: s.v, borderRadius: 4, marginBottom: 8 }}/>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{s.k}</div>
                <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 1 }}>{s.label}</div>
              </div>
            ))}
          </div>

          <H2 style={{ marginTop: 40 }}>Spacing & radii</H2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="sc-card" style={{ padding: 16 }}>
              <div className="sc-h" style={{ marginBottom: 10 }}>Spacing scale (px)</div>
              {[2,4,6,8,10,12,16,20,24,32,40].map(n => (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <div style={{ width: 34, fontSize: 11, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-4)" }}>{n}</div>
                  <div style={{ width: n, height: 10, background: "var(--sc-accent-400)", borderRadius: 2 }}/>
                </div>
              ))}
            </div>
            <div className="sc-card" style={{ padding: 16 }}>
              <div className="sc-h" style={{ marginBottom: 10 }}>Radii</div>
              {[["xs",3],["sm",5],["md",7],["lg",10],["xl",14],["2xl",20]].map(([k,v]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 44, fontSize: 11, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-4)" }}>{k}</div>
                  <div style={{ width: 40, height: 26, background: "var(--sc-surface-3)", border: "1px solid var(--sc-border-2)", borderRadius: v }}/>
                  <span style={{ fontSize: 11, color: "var(--sc-text-4)", fontFamily: "var(--sc-font-mono)" }}>{v}px</span>
                </div>
              ))}
            </div>
          </div>

          <H2 style={{ marginTop: 40 }}>Shadows</H2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, padding: 20, background: "var(--sc-chrome-2)", borderRadius: 8 }}>
            {["sh-1","sh-2","sh-3","sh-pop"].map(k => (
              <div key={k} style={{ textAlign: "center" }}>
                <div style={{ height: 70, background: "var(--sc-surface)", border: "1px solid var(--sc-border)", borderRadius: 8, boxShadow: `var(--sc-${k})`, marginBottom: 8 }}/>
                <div style={{ fontSize: 11, fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-3)" }}>{k}</div>
              </div>
            ))}
          </div>

          <H2 style={{ marginTop: 40 }}>Typography scale</H2>
          <div className="sc-card" style={{ padding: 18 }}>
            {[
              ["Display / 28·700", 28, 700, "The demo is the doc"],
              ["Title   / 18·600", 18, 600, "Render & export"],
              ["Section / 14·600", 14, 600, "Scene one — Landing page"],
              ["Body    / 13·500", 13, 500, "Auto-zoom focuses on the primary CTA after 400ms."],
              ["Body    / 12.5·400", 12.5, 400, "Customers pick a variant — we track the interaction across devices."],
              ["Caption / 11·500", 11, 500, "5 scenes · 1m 06s · h264"],
              ["Kbd     / 10.5·mono", 10.5, 500, "⌘ ⇧ R", true],
            ].map(([l, s, w, t, mono], i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "160px 1fr", padding: "8px 0", borderBottom: "1px solid var(--sc-border)", alignItems: "baseline" }}>
                <div style={{ fontSize: 10.5, color: "var(--sc-text-4)", fontFamily: "var(--sc-font-mono)" }}>{l}</div>
                <div style={{ fontSize: s, fontWeight: w, fontFamily: mono ? "var(--sc-font-mono)" : "var(--sc-font-ui)", color: "var(--sc-text)" }}>{t}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function H2({ children, style }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--sc-text-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, ...style }}>{children}</div>;
}
function P({ children }) {
  return <div style={{ fontSize: 12.5, color: "var(--sc-text-3)", marginBottom: 12, lineHeight: 1.55, maxWidth: 680 }}>{children}</div>;
}

Object.assign(window, { TokensScreen });
