import {
  ScBadge,
  ScButton,
  ScCard,
  ScInput,
  ScKbd,
  ScSegmented,
  ScSlider,
  ScSwitch,
} from "@storycapture/ui";
import { Check, ChevronDown, Download, Play, Plus, Search, Sparkles, User } from "lucide-react";
import { useState } from "react";

export default function DesignSystemComponentsRoute() {
  const [speed, setSpeed] = useState("1x");
  const [quality, setQuality] = useState("mid");
  const [volume, setVolume] = useState(60);
  const [gain, setGain] = useState(30);
  const [zoomOn, setZoomOn] = useState(true);
  const [smoothOn, setSmoothOn] = useState(false);

  return (
    <main id="main-content" className="h-full overflow-auto p-8">
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Components</div>
        <ScBadge tone="muted">Sc* primitives · shadcn/ui × Base UI</ScBadge>
      </div>

      <div style={{ maxWidth: 960, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: "28px 0" }}>
        <ScCard title="Buttons">
          <Row>
            <ScButton variant="primary">Primary</ScButton>
            <ScButton>Default</ScButton>
            <ScButton variant="ghost">Ghost</ScButton>
            <ScButton variant="danger">Record</ScButton>
            <ScButton variant="success" icon={<Download size={11} aria-hidden />}>
              Export
            </ScButton>
          </Row>
          <Row>
            <ScButton size="sm">Small</ScButton>
            <ScButton size="md">Medium</ScButton>
            <ScButton size="lg">Large</ScButton>
            <ScButton size="icon" icon={<Plus size={12} aria-hidden />} aria-label="New" />
            <ScButton disabled>Disabled</ScButton>
          </Row>
          <Row>
            <ScButton icon={<Play size={11} aria-hidden />}>Run</ScButton>
            <ScButton iconRight={<ChevronDown size={11} aria-hidden />}>Share</ScButton>
            <ScButton variant="primary" icon={<Sparkles size={11} aria-hidden />} kbd="⌘↵">
              AI pass
            </ScButton>
          </Row>
        </ScCard>

        <ScCard title="Inputs">
          <ScInput placeholder="Search" icon={<Search size={12} aria-hidden />} kbd="⌘F" />
          <div style={{ height: 8 }} />
          <ScInput placeholder="Project name" />
          <div style={{ height: 8 }} />
          <div style={{ display: "flex", gap: 6 }}>
            <ScInput placeholder="email@team.co" icon={<User size={12} aria-hidden />} />
            <ScButton variant="primary">Invite</ScButton>
          </div>
        </ScCard>

        <ScCard title="Badges">
          <Row>
            <ScBadge>Default</ScBadge>
            <ScBadge tone="accent" dot>Active</ScBadge>
            <ScBadge tone="success" icon={<Check size={9} aria-hidden />}>Rendered</ScBadge>
            <ScBadge tone="record" dot>Recording</ScBadge>
            <ScBadge tone="muted">Draft</ScBadge>
          </Row>
        </ScCard>

        <ScCard title="Switch &amp; Slider">
          <Row>
            <ScSwitch checked={zoomOn} onCheckedChange={setZoomOn} />
            <ScSwitch checked={smoothOn} onCheckedChange={setSmoothOn} />
            <span style={{ fontSize: 12, color: "var(--sc-text-3)" }}>Auto-zoom · Smoothing</span>
          </Row>
          <div style={{ marginTop: 10 }}>
            <ScSlider value={[volume]} onValueChange={(v) => setVolume(Array.isArray(v) ? (v[0] ?? 0) : v)} />
          </div>
          <div style={{ marginTop: 12 }}>
            <ScSlider value={[gain]} onValueChange={(v) => setGain(Array.isArray(v) ? (v[0] ?? 0) : v)} />
          </div>
        </ScCard>

        <ScCard title="Segmented">
          <ScSegmented
            value={speed}
            onValueChange={setSpeed}
            options={[
              { value: "0.5x", label: "0.5×" },
              { value: "1x", label: "1×" },
              { value: "2x", label: "2×" },
            ]}
          />
          <div style={{ height: 10 }} />
          <ScSegmented
            size="sm"
            value={quality}
            onValueChange={setQuality}
            options={[
              { value: "low", label: "Low" },
              { value: "mid", label: "Mid" },
              { value: "high", label: "High" },
            ]}
          />
        </ScCard>

        <ScCard title="Keyboard shortcuts">
          <Row>
            <span style={{ fontSize: 12, color: "var(--sc-text-3)" }}>Command palette</span>
            <ScKbd>⌘K</ScKbd>
          </Row>
          <Row>
            <span style={{ fontSize: 12, color: "var(--sc-text-3)" }}>Record</span>
            <ScKbd>⌘⇧R</ScKbd>
          </Row>
          <Row>
            <span style={{ fontSize: 12, color: "var(--sc-text-3)" }}>Export</span>
            <ScKbd>⌘E</ScKbd>
          </Row>
        </ScCard>
      </div>
    </main>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        alignItems: "center",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}
