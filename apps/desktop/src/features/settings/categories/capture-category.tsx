import { useState } from "react";
import { ScBadge, ScSegmented, ScSwitch } from "@storycapture/ui";

import {
  NotWiredCaption,
  SettingsCard,
  SettingsPanel,
  SettingsRow,
} from "../settings-row";

type BackendId = "sck" | "wgc" | "xcap";

const BACKENDS: {
  id: BackendId;
  name: string;
  sub: string;
  os: string;
  recommended?: boolean;
}[] = [
  {
    id: "sck",
    name: "ScreenCaptureKit",
    sub: "macOS 12.3+ · 60 fps · hardware cursor · recommended",
    os: "macOS",
    recommended: true,
  },
  {
    id: "wgc",
    name: "Windows Graphics Capture",
    sub: "Windows 10 2004+ · zero-copy via DX11",
    os: "Windows",
  },
  {
    id: "xcap",
    name: "xcap (cross-platform)",
    sub: "Fallback when native APIs unavailable · 30–60 fps",
    os: "Fallback",
  },
];

// Placeholder: pick_default_backend() chooses automatically at runtime; no user-facing picker yet.
export function CaptureCategory() {
  const [backend, setBackend] = useState<BackendId>("sck");

  return (
    <SettingsPanel
      title="Capture backend"
      desc="StoryCapture records your scripted browser session. Pick the backend best suited to your OS; fall-through is automatic on failure."
    >
      <div style={{ display: "grid", gap: 10 }}>
        {BACKENDS.map((b) => {
          const active = backend === b.id;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setBackend(b.id)}
              style={{
                padding: 14,
                border: `1px solid ${active ? "var(--sc-accent-400)" : "var(--sc-border)"}`,
                borderRadius: "var(--sc-r-md)",
                background: "var(--sc-surface)",
                cursor: "default",
                display: "grid",
                gridTemplateColumns: "16px 1fr auto",
                gap: 12,
                alignItems: "center",
                boxShadow: active ? "0 0 0 3px var(--sc-focus-ring)" : "none",
                textAlign: "left",
                color: "inherit",
              }}
              aria-pressed={active}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 99,
                  border: `1.5px solid ${active ? "var(--sc-accent-400)" : "var(--sc-border-strong)"}`,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {active && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 99,
                      background: "var(--sc-accent-400)",
                    }}
                  />
                )}
              </span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--sc-text-4)", marginTop: 2 }}>
                  {b.sub}
                </div>
              </div>
              <ScBadge tone={b.recommended ? "accent" : "muted"}>{b.os}</ScBadge>
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: 24 }}>
        <SettingsCard>
          <SettingsRow
            label="Capture fps"
            hint="Target. Falls back at playback time."
            control={
              <ScSegmented
                size="sm"
                value="60"
                disabled
                options={[
                  { value: "30", label: "30" },
                  { value: "60", label: "60" },
                  { value: "120", label: "120" },
                ]}
              />
            }
          />
          <SettingsRow
            label="Capture cursor"
            hint="Real cursor vs. synthesized path"
            control={<ScSwitch checked={false} disabled />}
          />
          <SettingsRow
            label="Color space"
            control={
              <ScSegmented
                size="sm"
                value="srgb"
                disabled
                options={[
                  { value: "srgb", label: "sRGB" },
                  { value: "p3", label: "Display P3" },
                  { value: "rec709", label: "Rec.709" },
                ]}
              />
            }
          />
          <SettingsRow
            label="Audio input"
            control={
              <ScSegmented
                size="sm"
                value="sys"
                disabled
                options={[
                  { value: "off", label: "Off" },
                  { value: "sys", label: "System" },
                  { value: "mic", label: "Mic" },
                ]}
              />
            }
            last
          />
        </SettingsCard>
      </div>

      <NotWiredCaption>
        Backend selection is a visual preview — runtime still uses
        <code style={{ margin: "0 4px" }}>pick_default_backend()</code>
        until the capture-settings plan lands.
      </NotWiredCaption>
    </SettingsPanel>
  );
}
