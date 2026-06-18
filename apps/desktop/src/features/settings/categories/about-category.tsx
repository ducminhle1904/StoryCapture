import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand";
import { appInfo } from "@/ipc";
import AutoUpdaterSettings from "../auto-updater";
import { SettingsPanel } from "../settings-row";

// Live: app metadata read from the host IPC.
export function AboutCategory() {
  const [appVersion, setAppVersion] = useState<string>("…");
  const [runtime, setRuntime] = useState<string>("Electron");

  useEffect(() => {
    appInfo()
      .then((info) => {
        setAppVersion(info.version);
        setRuntime(`Electron ${info.platform}/${info.arch}`);
      })
      .catch(() => {
        setAppVersion("unknown");
        setRuntime("Electron");
      });
  }, []);

  return (
    <SettingsPanel title="About">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: 16,
          border: "1px solid var(--sc-border)",
          borderRadius: "var(--sc-r-lg)",
          background: "var(--sc-surface)",
        }}
      >
        <BrandMark size={48} />
        <div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>StoryCapture</div>
          <div
            style={{
              fontSize: 12,
              color: "var(--sc-text-4)",
              marginTop: 2,
              fontFamily: "var(--sc-font-mono)",
            }}
          >
            v{appVersion} · {runtime}
          </div>
          <div style={{ fontSize: 12, color: "var(--sc-text-3)", marginTop: 8 }}>
            DSL → polished demo videos. Built for teams who ship demos daily.
          </div>
        </div>
      </div>

      <div style={{ marginTop: 28 }}>
        <h3
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--sc-text-4)",
            marginBottom: 12,
          }}
        >
          Updates
        </h3>
        <AutoUpdaterSettings />
      </div>
    </SettingsPanel>
  );
}
