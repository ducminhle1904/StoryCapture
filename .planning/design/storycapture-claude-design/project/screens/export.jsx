/* global React, I, Btn, Badge, Input, Select, Slider, Switch, Segmented, Row, Modal */

function ExportDialog({ open, onClose, onExport }) {
  const [res, setRes] = React.useState("1080p");
  const [codec, setCodec] = React.useState("h264");
  const [fps, setFps] = React.useState(60);
  const [hw, setHw] = React.useState(true);
  const [crf, setCrf] = React.useState(20);
  const [dest, setDest] = React.useState("~/Movies/StoryCapture/checkout-flow-v3.mp4");
  const [captions, setCaptions] = React.useState(true);
  const [stage, setStage] = React.useState("config"); // config | rendering | done

  const resOpts = { "720p": [1280, 720], "1080p": [1920, 1080], "1440p": [2560, 1440], "4k": [3840, 2160] };
  const [w, h] = resOpts[res];
  const estSize = Math.round(((w*h*fps) / 1_000_000) * 66 * (codec === "hevc" ? 0.6 : 1) * (crf < 20 ? 1.3 : crf > 24 ? 0.7 : 1));
  const duration = 66;
  const etaSec = Math.round(duration * (hw ? 0.55 : 1.8) * (codec === "hevc" ? 1.3 : 1));

  const startRender = () => {
    setStage("rendering");
    let p = 0;
    const int = setInterval(() => {
      p += 3 + Math.random() * 4;
      if (p >= 100) { p = 100; setStage("done"); clearInterval(int); onExport?.(); }
      document.getElementById("sc-render-bar")?.style.setProperty("--p", p + "%");
      const label = document.getElementById("sc-render-label");
      if (label) label.textContent = Math.round(p) + "%";
    }, 180);
  };

  return (
    <Modal open={open} onClose={stage !== "rendering" ? onClose : undefined} width={640}>
      {stage === "config" && (
        <>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--sc-border)", display: "flex", alignItems: "center", gap: 10 }}>
            <I.Download size={15}/>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Render & Export</div>
              <div style={{ fontSize: 11.5, color: "var(--sc-text-4)" }}>checkout_flow.story · 5 scenes · 1m 06s</div>
            </div>
            <span style={{ flex: 1 }}/>
            <Btn variant="ghost" size="icon" icon={<I.X size={13}/>} onClick={onClose}/>
          </div>
          <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <div>
              <div className="sc-h" style={{ marginBottom: 10 }}>Output</div>
              <Row label="Resolution">
                <Select value={res} onChange={setRes} options={[
                  { value: "720p",  label: "720p  (1280 × 720)" },
                  { value: "1080p", label: "1080p (1920 × 1080)" },
                  { value: "1440p", label: "1440p (2560 × 1440)" },
                  { value: "4k",    label: "4K    (3840 × 2160)" },
                ]}/>
              </Row>
              <Row label="Frame rate">
                <Segmented size="sm" value={String(fps)} onChange={v => setFps(Number(v))} options={[
                  { value: "30", label: "30" },
                  { value: "60", label: "60" },
                  { value: "120", label: "120" },
                ]}/>
              </Row>
              <Row label="Codec">
                <Segmented size="sm" value={codec} onChange={setCodec} options={[
                  { value: "h264", label: "H.264" },
                  { value: "hevc", label: "HEVC" },
                  { value: "prores", label: "ProRes" },
                ]}/>
              </Row>
              <Row label="Quality" hint={`CRF ${crf} · ${crf < 19 ? "Visually lossless" : crf < 23 ? "High" : "Balanced"}`}>
                <Slider value={crf} min={14} max={30} onChange={setCrf}/>
              </Row>
              <Row label="HW encoder" hint="Apple VideoToolbox">
                <Switch checked={hw} onChange={setHw}/>
              </Row>
            </div>
            <div>
              <div className="sc-h" style={{ marginBottom: 10 }}>Destination & extras</div>
              <Row label="Save to">
                <Input value={dest} onChange={e => setDest(e.target.value)} icon={<I.FolderOpen size={12}/>}/>
              </Row>
              <Row label="Captions" hint="Generated from narration">
                <Switch checked={captions} onChange={setCaptions}/>
              </Row>
              <Row label="Thumbnail">
                <Segmented size="sm" value="auto" onChange={() => {}} options={[
                  { value: "off", label: "None" },
                  { value: "auto", label: "Auto" },
                  { value: "frame", label: "Pick frame" },
                ]}/>
              </Row>
              <Row label="Also upload">
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <Badge variant="accent" icon={<I.Check size={9}/>}>Loom</Badge>
                  <Badge variant="muted">+ S3</Badge>
                  <Badge variant="muted">+ Notion</Badge>
                </div>
              </Row>
              <div style={{ marginTop: 16, padding: 12, background: "var(--sc-surface-2)", border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-md)" }}>
                <div style={{ fontSize: 11, color: "var(--sc-text-4)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Summary</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 12, fontSize: 12 }}>
                  <span style={{ color: "var(--sc-text-4)" }}>Size est.</span>
                  <span style={{ fontFamily: "var(--sc-font-mono)", textAlign: "right" }}>~{estSize} MB</span>
                  <span style={{ color: "var(--sc-text-4)" }}>Render ETA</span>
                  <span style={{ fontFamily: "var(--sc-font-mono)", textAlign: "right" }}>~{Math.floor(etaSec/60)}m {etaSec%60}s</span>
                  <span style={{ color: "var(--sc-text-4)" }}>Bitrate</span>
                  <span style={{ fontFamily: "var(--sc-font-mono)", textAlign: "right" }}>{Math.round(12 + (30-crf)*1.2)} Mbps</span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ padding: "12px 18px", borderTop: "1px solid var(--sc-border)", display: "flex", gap: 8, alignItems: "center" }}>
            <Btn variant="ghost" icon={<I.File size={12}/>}>Save preset</Btn>
            <span style={{ flex: 1 }}/>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn variant="success" icon={<I.Download size={12}/>} onClick={startRender}>Start render</Btn>
          </div>
        </>
      )}

      {stage === "rendering" && (
        <div style={{ padding: 28 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Rendering…</div>
          <div style={{ fontSize: 11.5, color: "var(--sc-text-4)", marginBottom: 20 }}>Encoding {res} · {codec.toUpperCase()} · {hw ? "VideoToolbox" : "software"}</div>

          <div style={{
            height: 8, borderRadius: 99, background: "var(--sc-surface-3)", overflow: "hidden", marginBottom: 6,
          }}>
            <div id="sc-render-bar" style={{
              height: "100%",
              width: "var(--p, 6%)",
              background: "linear-gradient(90deg, var(--sc-accent-500), var(--sc-accent-300))",
              transition: "width 0.18s linear",
            }}/>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--sc-text-4)", fontFamily: "var(--sc-font-mono)", marginBottom: 20 }}>
            <span>frame 1842 / 3960</span>
            <span id="sc-render-label">6%</span>
            <span>ETA ~42s · 72 fps</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              { label: "Captured", status: "done" },
              { label: "Post-processed", status: "done" },
              { label: "Encoding video", status: "running" },
              { label: "Mixing audio", status: "running" },
              { label: "Muxing MP4", status: "pending" },
              { label: "Uploading", status: "pending" },
            ].map((s, i) => (
              <div key={i} style={{
                padding: "8px 10px", border: "1px solid var(--sc-border)", borderRadius: "var(--sc-r-md)",
                background: s.status === "running" ? "oklch(0.78 0.14 var(--sc-accent-h) / 0.08)" : "var(--sc-surface-2)",
                fontSize: 11.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 500 }}>
                  {s.status === "done" && <I.Check size={11} style={{ color: "var(--sc-success)" }}/>}
                  {s.status === "running" && <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--sc-accent-400)", animation: "sc-pulse 1.2s ease infinite" }}/>}
                  {s.status === "pending" && <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--sc-surface-4)" }}/>}
                  {s.label}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
            <Btn variant="ghost">Run in background</Btn>
            <Btn variant="danger" icon={<I.Stop size={11}/>}>Cancel render</Btn>
          </div>
        </div>
      )}

      {stage === "done" && (
        <div style={{ padding: 28, textAlign: "center" }}>
          <div style={{ width: 56, height: 56, margin: "0 auto 16px", borderRadius: 99, background: "oklch(0.72 0.14 170 / 0.15)", border: "1px solid oklch(0.72 0.14 170 / 0.3)", display: "grid", placeItems: "center" }}>
            <I.Check size={26} style={{ color: "var(--sc-success)" }}/>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Render complete</div>
          <div style={{ fontSize: 12, color: "var(--sc-text-3)", marginBottom: 18, fontFamily: "var(--sc-font-mono)" }}>
            checkout-flow-v3.mp4 · {estSize} MB · {res} · {codec.toUpperCase()}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <Btn icon={<I.FolderOpen size={12}/>}>Reveal in Finder</Btn>
            <Btn icon={<I.Copy size={12}/>}>Copy share link</Btn>
            <Btn variant="primary" icon={<I.Play size={11}/>} onClick={onClose}>Play</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

Object.assign(window, { ExportDialog });
