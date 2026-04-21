/* global React, I, Btn, Badge, Input, Ph, Segmented */
// Project dashboard
const PROJECTS = [
  { id: 1, title: "Checkout flow — v3", subtitle: "7 scenes · 1m 24s", updated: "2 min ago", status: "ready", accent: 60, hash: "a3f" },
  { id: 2, title: "Onboarding walkthrough", subtitle: "12 scenes · 3m 02s", updated: "18 min ago", status: "rendering", progress: 0.62, accent: 220, hash: "b2e" },
  { id: 3, title: "Team settings demo", subtitle: "4 scenes · 0m 42s", updated: "1 hr ago", status: "ready", accent: 170, hash: "9c1" },
  { id: 4, title: "AI search — beta tour", subtitle: "9 scenes · 2m 11s", updated: "yesterday", status: "draft", accent: 300, hash: "44f" },
  { id: 5, title: "Billing migration FAQ", subtitle: "6 scenes · 1m 48s", updated: "2 days ago", status: "ready", accent: 40, hash: "7d9" },
  { id: 6, title: "Keyboard shortcuts reel", subtitle: "14 scenes · 0m 58s", updated: "3 days ago", status: "failed", accent: 0, hash: "12b" },
];

const STATUS = {
  ready:     { label: "Ready", variant: "muted", dot: true },
  rendering: { label: "Rendering", variant: "accent", dot: true },
  draft:     { label: "Draft", variant: "muted", dot: true },
  failed:    { label: "Failed", variant: "record", dot: true },
};

function ThumbMock({ accent, hash, progress }) {
  // A fake "scene" thumbnail — stylized browser mock inside a gradient frame
  return (
    <div style={{
      position: "relative",
      aspectRatio: "16/10",
      borderRadius: "var(--sc-r-md)",
      background: `
        radial-gradient(ellipse 60% 80% at 20% 10%, oklch(0.45 0.12 ${accent}) 0%, transparent 60%),
        radial-gradient(ellipse 80% 60% at 80% 100%, oklch(0.32 0.10 ${(accent+40)%360}) 0%, transparent 60%),
        linear-gradient(180deg, oklch(0.18 0.04 ${accent}), oklch(0.12 0.02 ${accent}))`,
      overflow: "hidden",
      border: "1px solid var(--sc-border-2)",
    }}>
      {/* simulated browser inside */}
      <div style={{
        position: "absolute", inset: "14% 10% 14% 10%",
        background: "oklch(0.97 0.004 80)",
        borderRadius: 3,
        boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ height: 10, background: "oklch(0.93 0.004 80)", display: "flex", alignItems: "center", gap: 3, padding: "0 4px", borderBottom: "0.5px solid #0001" }}>
          <span style={{ width: 2, height: 2, borderRadius: 99, background: "#ff5f57" }}/>
          <span style={{ width: 2, height: 2, borderRadius: 99, background: "#febc2e" }}/>
          <span style={{ width: 2, height: 2, borderRadius: 99, background: "#28c840" }}/>
        </div>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "30% 1fr", gap: 3, padding: 4 }}>
          <div style={{ background: "oklch(0.88 0.004 80)", borderRadius: 2 }}/>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ height: 6, background: `oklch(0.78 0.14 ${accent})`, borderRadius: 2, width: "70%" }}/>
            <div style={{ height: 3, background: "oklch(0.85 0.004 80)", borderRadius: 2 }}/>
            <div style={{ height: 3, background: "oklch(0.85 0.004 80)", borderRadius: 2, width: "80%" }}/>
            <div style={{ flex: 1, background: `repeating-linear-gradient(135deg, oklch(0.88 0.004 80) 0 3px, oklch(0.94 0.004 80) 3px 6px)`, borderRadius: 2 }}/>
          </div>
        </div>
      </div>
      {/* hash badge */}
      <div style={{ position: "absolute", top: 6, right: 6, fontFamily: "var(--sc-font-mono)", fontSize: 9, color: "rgba(255,255,255,0.6)", background: "rgba(0,0,0,0.4)", padding: "1px 4px", borderRadius: 3 }}>
        #{hash}
      </div>
      {progress != null && (
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 3, background: "rgba(0,0,0,0.4)" }}>
          <div style={{ height: "100%", width: `${progress*100}%`, background: "var(--sc-accent-400)" }}/>
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p, onOpen }) {
  const st = STATUS[p.status];
  return (
    <div className="sc-card" style={{ padding: 10, cursor: "default" }}
      onClick={onOpen}
      onMouseEnter={e => e.currentTarget.style.borderColor = "var(--sc-border-strong)"}
      onMouseLeave={e => e.currentTarget.style.borderColor = ""}>
      <ThumbMock accent={p.accent} hash={p.hash} progress={p.status === "rendering" ? p.progress : null}/>
      <div style={{ padding: "10px 4px 2px", display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.title}</div>
          <div style={{ fontSize: 11.5, color: "var(--sc-text-4)", marginTop: 2 }}>{p.subtitle}</div>
        </div>
        <Badge variant={st.variant} dot={st.dot}>{st.label}</Badge>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 4px 0", borderTop: "1px solid var(--sc-border)", marginTop: 8, fontSize: 11, color: "var(--sc-text-4)" }}>
        <I.Clock size={11}/> {p.updated}
        <span style={{ flex: 1 }}/>
        <Btn size="sm" variant="ghost" icon={<I.PlayOutline size={11}/>}>Play</Btn>
        <Btn size="sm" variant="ghost" icon={<I.MoreH size={14}/>} />
      </div>
    </div>
  );
}

function RecentRenderRail() {
  const items = [
    { title: "Checkout flow — v3", time: "00:01:24", when: "2m ago", size: "18.4 MB", codec: "h264" },
    { title: "Team settings demo", time: "00:00:42", when: "1h ago", size: "9.2 MB", codec: "hevc" },
    { title: "Billing migration FAQ", time: "00:01:48", when: "2d ago", size: "24.7 MB", codec: "h264" },
    { title: "Onboarding walkthrough (preview)", time: "00:03:02", when: "2d ago", size: "41.8 MB", codec: "h264" },
  ];
  return (
    <div style={{ borderTop: "1px solid var(--sc-border)", background: "var(--sc-chrome-2)" }}>
      <div style={{ padding: "12px 20px 8px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--sc-text-3)" }}>Recent renders</div>
        <Badge variant="muted">12 this week</Badge>
        <span style={{ flex: 1 }}/>
        <Btn size="sm" variant="ghost">View all</Btn>
      </div>
      <div style={{ display: "flex", gap: 10, padding: "0 20px 16px", overflowX: "auto" }}>
        {items.map((r, i) => (
          <div key={i} className="sc-card" style={{ flex: "0 0 240px", padding: 8, display: "flex", gap: 10 }}>
            <div style={{
              width: 64, aspectRatio: "16/10", flexShrink: 0,
              borderRadius: 4,
              background: `linear-gradient(135deg, oklch(0.25 0.05 ${60 + i*40}), oklch(0.15 0.03 ${60 + i*40}))`,
              display: "grid", placeItems: "center",
              border: "1px solid var(--sc-border-2)",
            }}>
              <I.Play size={14} style={{ color: "rgba(255,255,255,0.8)" }}/>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
              <div style={{ fontSize: 10.5, color: "var(--sc-text-4)", marginTop: 2, fontFamily: "var(--sc-font-mono)" }}>{r.time} · {r.codec}</div>
              <div style={{ fontSize: 10.5, color: "var(--sc-text-4)", marginTop: 1 }}>{r.when} · {r.size}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardScreen({ onOpen, onNewStory, empty }) {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const visible = PROJECTS.filter(p =>
    (filter === "all" || p.status === filter) &&
    p.title.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Toolbar */}
      <div className="sc-toolbar">
        <div>
          <div className="sc-toolbar-title">Projects</div>
          <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 1 }}>{empty ? "No stories yet" : `${PROJECTS.length} stories · 12 rendered this week`}</div>
        </div>
        <span className="sc-spacer"/>
        <Input icon={<I.Search size={13}/>} placeholder="Search stories" value={search} onChange={e => setSearch(e.target.value)} wrapStyle={{ width: 240 }} kbd="⌘F"/>
        <Segmented value={filter} onChange={setFilter} size="sm" options={[
          { value: "all", label: "All" },
          { value: "ready", label: "Ready" },
          { value: "rendering", label: "Rendering" },
          { value: "draft", label: "Drafts" },
        ]}/>
        <Btn variant="primary" icon={<I.Plus size={13}/>} onClick={onNewStory} kbd="⌘N">New Story</Btn>
      </div>

      {/* Content */}
      <div className="sc-scroll" style={{ flex: 1, padding: 20 }}>
        {empty ? (
          <EmptyDashboard onNewStory={onNewStory}/>
        ) : (
          <>
            {/* Pinned row */}
            <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
              <div className="sc-h">Active</div>
              <div style={{ height: 1, flex: 1, background: "var(--sc-border)" }}/>
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 14,
            }}>
              {visible.map(p => <ProjectCard key={p.id} p={p} onOpen={() => onOpen(p)} />)}
              {/* New card */}
              <div className="sc-card" style={{
                padding: 10, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", minHeight: 232,
                borderStyle: "dashed", borderColor: "var(--sc-border-2)",
                cursor: "default",
              }} onClick={onNewStory}>
                <div style={{ width: 36, height: 36, borderRadius: 99, background: "var(--sc-surface-3)", display: "grid", placeItems: "center", marginBottom: 10 }}>
                  <I.Plus size={16} style={{ color: "var(--sc-text-3)" }}/>
                </div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>New Story</div>
                <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 2 }}>⌘N · blank, template, or import .story</div>
              </div>
            </div>
          </>
        )}
      </div>
      {!empty && <RecentRenderRail/>}
    </div>
  );
}

function EmptyDashboard({ onNewStory }) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: 400, padding: 40 }}>
      <div style={{ textAlign: "center", maxWidth: 460 }}>
        {/* Hero illustration: stacked film strips */}
        <div style={{ position: "relative", width: 160, height: 110, margin: "0 auto 24px" }}>
          {[0,1,2].map(i => (
            <div key={i} style={{
              position: "absolute", inset: `${i*8}px ${i*14}px`,
              background: `linear-gradient(135deg, oklch(${0.35 - i*0.06} 0.08 78), oklch(${0.22 - i*0.04} 0.04 78))`,
              border: "1px solid var(--sc-border-2)",
              borderRadius: 8,
              transform: `rotate(${-4 + i*3}deg)`,
              boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
            }}>
              <div style={{ position: "absolute", top: 6, left: 6, right: 6, height: 3, background: "oklch(0.78 0.14 78 / 0.6)", borderRadius: 1 }}/>
              <div style={{ position: "absolute", top: 14, left: 6, right: 30, height: 2, background: "rgba(255,255,255,0.2)", borderRadius: 1 }}/>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Write your first story</div>
        <div style={{ fontSize: 13, color: "var(--sc-text-3)", lineHeight: 1.5, marginBottom: 20 }}>
          StoryCapture turns a 30-line DSL into a polished demo video. Start with a template — or paste a `.story` file from your repo.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <Btn variant="primary" icon={<I.Plus size={13}/>} onClick={onNewStory}>New Story</Btn>
          <Btn icon={<I.FolderOpen size={13}/>}>Import .story</Btn>
          <Btn variant="ghost" icon={<I.File size={13}/>}>Browse templates</Btn>
        </div>
        <div style={{ marginTop: 24, fontSize: 11, color: "var(--sc-text-4)" }}>
          Try <span className="sc-kbd">⌘K</span> for commands, or read the <span style={{ color: "var(--sc-accent-400)", textDecoration: "underline", textUnderlineOffset: 2 }}>DSL quickstart →</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { DashboardScreen });
