/* global React, I, Btn, TitleBar, SideNav, TweaksPanel, CommandPalette, RecordingIndicator, ToastStack,
   DashboardScreen, EditorScreen, PostProdScreen, ExportDialog, SettingsScreen, TokensScreen, ComponentsScreen */

/* app scope — avoid re-declaring React hooks at top-level (each babel script shares scope) */

function App() {
  const [screen, setScreen] = useState(() => localStorage.getItem("sc-screen") || "dashboard");
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [empty, setEmpty] = useState({ dashboard: false, post: false });

  const [tweaks, setTweaksState] = useState(() => {
    const fromLs = localStorage.getItem("sc-tweaks");
    if (fromLs) try { return { ...window.SC_TWEAKS, ...JSON.parse(fromLs) }; } catch (e) {}
    return window.SC_TWEAKS;
  });
  const setTweaks = (next) => {
    setTweaksState(next);
    localStorage.setItem("sc-tweaks", JSON.stringify(next));
    try { window.parent.postMessage({ type: "__edit_mode_set_keys", edits: next }, "*"); } catch (e) {}
  };

  // Apply theme + tokens to root
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", tweaks.theme);
    root.setAttribute("data-platform", tweaks.platform);
    root.setAttribute("data-density", tweaks.density);
    root.setAttribute("data-radius", tweaks.radius);
    root.style.setProperty("--sc-accent-h", tweaks.accentHue);
  }, [tweaks]);

  // Persist current screen
  useEffect(() => { localStorage.setItem("sc-screen", screen); }, [screen]);

  // Recording timer
  useEffect(() => {
    if (!recording) return;
    const int = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(int);
  }, [recording]);

  // Tweak mode contract with host
  useEffect(() => {
    const h = (ev) => {
      if (ev.data?.type === "__activate_edit_mode") setTweaksOpen(true);
      if (ev.data?.type === "__deactivate_edit_mode") setTweaksOpen(false);
    };
    window.addEventListener("message", h);
    try { window.parent.postMessage({ type: "__edit_mode_available" }, "*"); } catch (e) {}
    return () => window.removeEventListener("message", h);
  }, []);

  // Global keyboard
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "k") { e.preventDefault(); setPaletteOpen(o => !o); }
      if (mod && e.key === "e") { e.preventDefault(); setExportOpen(true); }
      if (mod && e.shiftKey && e.key.toLowerCase() === "r") { e.preventDefault(); toggleRecord(); }
      if (e.key === "Escape") { setPaletteOpen(false); setTweaksOpen(false); }
      if (mod && ["1","2","3","4","5"].includes(e.key)) {
        e.preventDefault();
        setScreen(["dashboard","editor","post","export","settings"][Number(e.key)-1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fireToast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(ts => [...ts, { id, ...t }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 6000);
  }, []);

  const toggleRecord = () => {
    setRecording(r => {
      if (r) {
        fireToast({ kind: "success", title: "Capture saved", desc: "scene-2.mp4 · 11.4 MB · queued for post-prod", actions: [{ label: "Open in post-prod" }]});
        setElapsed(0);
      } else {
        fireToast({ kind: "info", title: "Recording started", desc: "Playing scene 1/4 · checkout_flow.story" });
      }
      return !r;
    });
  };

  const onPaletteNav = (id) => {
    if (id === "export" || id === "new-story") return setExportOpen(id === "export");
    if (id === "record") return toggleRecord();
    if (["dashboard","editor","post","settings","tokens","components"].includes(id)) setScreen(id);
    if (id === "shortcuts") setScreen("settings");
  };

  const screenNode = (() => {
    switch (screen) {
      case "dashboard": return <DashboardScreen onOpen={() => setScreen("editor")} onNewStory={() => { setScreen("editor"); fireToast({kind:"info", title:"New story", desc:"Started from the blank template."}); }} empty={empty.dashboard}/>;
      case "editor":    return <EditorScreen recording={recording} onRecord={toggleRecord} onOpenExport={() => setExportOpen(true)}/>;
      case "post":      return <PostProdScreen empty={empty.post}/>;
      case "export":    return <ExportLanding onOpen={() => setExportOpen(true)} />;
      case "renders":   return <ExportLanding onOpen={() => setExportOpen(true)} renders/>;
      case "settings":  return <SettingsScreen/>;
      case "tokens":    return <TokensScreen/>;
      case "components":return <ComponentsScreen fireToast={fireToast}/>;
      default: return null;
    }
  })();

  const winTitle = {
    dashboard: "Projects",
    editor: "Story Editor",
    post: "Post-Production",
    export: "Render & Export",
    renders: "Recent Renders",
    settings: "Settings",
    tokens: "Design Tokens",
    components: "Components",
  }[screen];

  return (
    <div className="sc-stage">
      <div className="sc-window" data-screen-label={`StoryCapture — ${winTitle}`}>
        <TitleBar platform={tweaks.platform} title="StoryCapture" subtitle={winTitle}/>
        <div className="sc-shell">
          <SideNav active={screen} onChange={setScreen}
            onOpenPalette={() => setPaletteOpen(true)}
            onStartRecord={toggleRecord}
            recording={recording}/>
          <div className="sc-main">
            {screenNode}
            <RecordingIndicator recording={recording} elapsed={elapsed} onStop={toggleRecord}/>
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={onPaletteNav}/>
            <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} onExport={() => fireToast({ kind: "success", title: "Export ready", desc: "checkout-flow-v3.mp4 · ~18 MB", actions: [{ label: "Reveal" }] })}/>
            <TweaksPanel open={tweaksOpen} onClose={() => setTweaksOpen(false)} tweaks={tweaks} setTweaks={setTweaks}/>
            <ToastStack toasts={toasts} dismiss={(id) => setToasts(ts => ts.filter(x => x.id !== id))}/>

            {/* Empty-state toggles — dev affordance, wrapped in small pill */}
            {(screen === "dashboard" || screen === "post") && (
              <div style={{ position: "absolute", top: 54, right: 16, zIndex: 20, display: "flex", gap: 4, alignItems: "center", background: "var(--sc-surface)", border: "1px solid var(--sc-border)", padding: "3px 4px 3px 8px", borderRadius: 99, boxShadow: "var(--sc-sh-1)" }}>
                <span style={{ fontSize: 10.5, color: "var(--sc-text-4)", fontFamily: "var(--sc-font-mono)", textTransform: "uppercase", letterSpacing: "0.05em" }}>state</span>
                <Btn size="sm" variant={empty[screen === "dashboard" ? "dashboard" : "post"] ? "ghost" : "default"} onClick={() => setEmpty(s => ({ ...s, [screen === "dashboard" ? "dashboard" : "post"]: false }))}>Filled</Btn>
                <Btn size="sm" variant={empty[screen === "dashboard" ? "dashboard" : "post"] ? "default" : "ghost"} onClick={() => setEmpty(s => ({ ...s, [screen === "dashboard" ? "dashboard" : "post"]: true }))}>Empty</Btn>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tweaks FAB (shown when host hasn't toggled tweaks mode) */}
      {!tweaksOpen && (
        <button onClick={() => setTweaksOpen(true)}
          title="Open tweaks"
          style={{
            position: "fixed", bottom: 16, right: 16,
            width: 36, height: 36, borderRadius: 99,
            background: "var(--sc-surface)",
            border: "1px solid var(--sc-border-2)",
            color: "var(--sc-text-2)",
            display: "grid", placeItems: "center",
            cursor: "pointer",
            boxShadow: "var(--sc-sh-2)",
            zIndex: 50,
          }}>
          <I.Wand size={14}/>
        </button>
      )}
    </div>
  );
}

function ExportLanding({ onOpen, renders }) {
  const list = [
    { t: "checkout-flow-v3", when: "2 min ago", dur: "01:06", size: "18.4 MB", codec: "h264", status: "done", hue: 60 },
    { t: "onboarding-walkthrough", when: "18 min ago", dur: "03:02", size: "41.8 MB", codec: "h264", status: "rendering", hue: 220 },
    { t: "team-settings-demo", when: "1 hr ago", dur: "00:42", size: "9.2 MB", codec: "hevc", status: "done", hue: 170 },
    { t: "billing-migration-faq", when: "yesterday", dur: "01:48", size: "24.7 MB", codec: "h264", status: "done", hue: 40 },
    { t: "shortcuts-reel", when: "2d ago", dur: "00:58", size: "7.1 MB", codec: "hevc", status: "failed", hue: 0 },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">{renders ? "Recent Renders" : "Render & Export"}</div>
        <span className="sc-spacer"/>
        <Btn variant="primary" icon={<I.Download size={12}/>} onClick={onOpen} kbd="⌘E">New render…</Btn>
      </div>
      <div className="sc-scroll" style={{ flex: 1, padding: 20 }}>
        <div className="sc-card" style={{ overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 120px 120px 100px 80px 40px", padding: "10px 14px", borderBottom: "1px solid var(--sc-border)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--sc-text-4)", fontWeight: 600 }}>
            <span></span><span>Name</span><span>Updated</span><span>Duration</span><span>Size</span><span>Codec</span><span></span>
          </div>
          {list.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 1fr 120px 120px 100px 80px 40px", padding: "10px 14px", borderBottom: i < list.length-1 ? "1px solid var(--sc-border)" : "none", alignItems: "center", fontSize: 12.5 }}>
              <div style={{ width: 44, height: 26, borderRadius: 3, background: `linear-gradient(135deg, oklch(0.35 0.10 ${r.hue}), oklch(0.18 0.06 ${r.hue}))`, display: "grid", placeItems: "center" }}>
                <I.Play size={10} style={{ color: "rgba(255,255,255,0.8)" }}/>
              </div>
              <div>
                <div style={{ fontFamily: "var(--sc-font-mono)", fontSize: 12 }}>{r.t}.mp4</div>
                {r.status === "rendering" && <div style={{ fontSize: 10, color: "var(--sc-accent-400)", marginTop: 2 }}>encoding · 62%</div>}
                {r.status === "failed" && <div style={{ fontSize: 10, color: "oklch(0.78 0.18 22)", marginTop: 2 }}>failed · SCK permission</div>}
              </div>
              <span style={{ color: "var(--sc-text-3)", fontSize: 11.5 }}>{r.when}</span>
              <span style={{ fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-3)" }}>{r.dur}</span>
              <span style={{ fontFamily: "var(--sc-font-mono)", color: "var(--sc-text-3)" }}>{r.size}</span>
              <span><Badge variant="muted">{r.codec}</Badge></span>
              <span style={{ textAlign: "right", color: "var(--sc-text-4)" }}><I.MoreH size={14}/></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
