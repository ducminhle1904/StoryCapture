import { useState, type ReactNode } from "react";
import {
  Download,
  FileText,
  Info,
  Key,
  Keyboard,
  Lock,
  Monitor,
  User,
  Settings as SettingsIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ScBadge, ScButton } from "@storycapture/ui";

import { PageContentTransition } from "@/components/page-content-transition";
import { GeneralCategory } from "@/features/settings/categories/general-category";
import { ApiKeysCategory } from "@/features/settings/categories/api-keys-category";
import { CaptureCategory } from "@/features/settings/categories/capture-category";
import { RenderCategory } from "@/features/settings/categories/render-category";
import { KeyboardCategory } from "@/features/settings/categories/keyboard-category";
import { PrivacyCategory } from "@/features/settings/categories/privacy-category";
import { LogsCategory } from "@/features/settings/categories/logs-category";
import { AboutCategory } from "@/features/settings/categories/about-category";
import { AccountCategory } from "@/features/settings/categories/account-category";
import { useAppSettingsStore } from "@/state/app-settings";
import type { SettingsCategory } from "@/ipc/settings";
import {
  applyCaptureFpsDefault,
  DEFAULT_EXPORT_KNOBS,
  PRESET_BUNDLES,
  useOutputPrefsStore,
} from "@/state/output-prefs";

type SectionId =
  | "general"
  | "keys"
  | "capture"
  | "render"
  | "kbd"
  | "privacy"
  | "account"
  | "logs"
  | "about";

interface Section {
  id: SectionId;
  label: string;
  icon: ReactNode;
}

const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: <SettingsIcon size={12} /> },
  { id: "keys", label: "API keys", icon: <Key size={12} /> },
  { id: "capture", label: "Capture defaults", icon: <Monitor size={12} /> },
  { id: "render", label: "Render defaults", icon: <Download size={12} /> },
  { id: "kbd", label: "Keyboard", icon: <Keyboard size={12} /> },
  { id: "privacy", label: "Privacy & telemetry", icon: <Lock size={12} /> },
  { id: "account", label: "Web account", icon: <User size={12} /> },
  { id: "logs", label: "Logs", icon: <FileText size={12} /> },
  { id: "about", label: "About", icon: <Info size={12} /> },
];

const RESET_CATEGORY: Partial<Record<SectionId, SettingsCategory>> = {
  general: "general",
  capture: "capture",
  render: "render",
  privacy: "privacy",
  about: "updates",
};

export default function SettingsRoute() {
  const [section, setSection] = useState<SectionId>("general");
  const resetCategory = useAppSettingsStore((s) => s.resetCategory);
  const settings = useAppSettingsStore((s) => s.settings);
  const resetTarget = RESET_CATEGORY[section];
  const applyPreset = useOutputPrefsStore((s) => s.applyPreset);
  const setRecordingKnob = useOutputPrefsStore((s) => s.setRecordingKnob);
  const setExportKnob = useOutputPrefsStore((s) => s.setExportKnob);

  const resetActive = async () => {
    if (!resetTarget) return;
    try {
      const next = await resetCategory(resetTarget);
      if (resetTarget === "capture") {
        applyCaptureFpsDefault(next.capture);
      }
      if (resetTarget === "render") {
        applyPreset("Standard");
        setRecordingKnob("resolution", PRESET_BUNDLES.Standard.resolution);
        setExportKnob("hwEncoder", DEFAULT_EXPORT_KNOBS.hwEncoder);
      }
      toast.success("Settings reset");
    } catch (err) {
      toast.error("Could not reset settings", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <main
      id="main-content"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Settings</div>
        <ScBadge tone="muted">Workspace · Local</ScBadge>
        <span className="sc-spacer" />
        {resetTarget && settings ? (
          <ScButton size="sm" variant="ghost" onClick={() => void resetActive()}>
            Reset to defaults
          </ScButton>
        ) : null}
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav
          aria-label="Settings sections"
          style={{
            width: 200,
            borderRight: "1px solid var(--sc-border)",
            background: "var(--sc-chrome-2)",
            padding: "10px 0",
          }}
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`sc-nav-item ${section === s.id ? "active" : ""}`}
              style={{
                width: "100%",
                fontSize: 12,
                textAlign: "left",
                border: "none",
                background: "transparent",
                color: section === s.id ? "var(--sc-accent-400)" : "inherit",
                cursor: "default",
              }}
              aria-current={section === s.id ? "page" : undefined}
            >
              <span
                style={{
                  width: 14,
                  display: "grid",
                  placeItems: "center",
                  color: section === s.id ? "currentColor" : "var(--sc-text-3)",
                }}
              >
                {s.icon}
              </span>
              {s.label}
            </button>
          ))}
        </nav>

        <PageContentTransition
          className="sc-scroll"
          style={{ flex: 1, padding: "24px 32px" }}
        >
          {section === "general" && <GeneralCategory />}
          {section === "keys" && <ApiKeysCategory />}
          {section === "capture" && <CaptureCategory />}
          {section === "render" && <RenderCategory />}
          {section === "kbd" && <KeyboardCategory />}
          {section === "privacy" && <PrivacyCategory />}
          {section === "account" && <AccountCategory />}
          {section === "logs" && <LogsCategory />}
          {section === "about" && <AboutCategory />}
        </PageContentTransition>
      </div>
    </main>
  );
}
