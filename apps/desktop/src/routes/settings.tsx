import { ScBadge, ScButton } from "@storycapture/ui";
import {
  Download,
  FileText,
  Info,
  Key,
  Keyboard,
  Lock,
  Monitor,
  Settings as SettingsIcon,
  User,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { PageContentTransition } from "@/components/page-content-transition";
import { AboutCategory } from "@/features/settings/categories/about-category";
import { AccountCategory } from "@/features/settings/categories/account-category";
import { ApiKeysCategory } from "@/features/settings/categories/api-keys-category";
import { CaptureCategory } from "@/features/settings/categories/capture-category";
import { GeneralCategory } from "@/features/settings/categories/general-category";
import { KeyboardCategory } from "@/features/settings/categories/keyboard-category";
import { LogsCategory } from "@/features/settings/categories/logs-category";
import { PrivacyCategory } from "@/features/settings/categories/privacy-category";
import { RenderCategory } from "@/features/settings/categories/render-category";
import type { SettingsCategory } from "@/ipc/settings";
import { useAppSettingsStore } from "@/state/app-settings";
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
  group: "Workspace" | "Capture" | "Output" | "Connections" | "System";
}

const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: <SettingsIcon size={12} />, group: "Workspace" },
  { id: "account", label: "Web account", icon: <User size={12} />, group: "Workspace" },
  { id: "kbd", label: "Keyboard", icon: <Keyboard size={12} />, group: "Workspace" },
  { id: "capture", label: "Capture defaults", icon: <Monitor size={12} />, group: "Capture" },
  { id: "render", label: "Render defaults", icon: <Download size={12} />, group: "Output" },
  { id: "keys", label: "API keys", icon: <Key size={12} />, group: "Connections" },
  { id: "privacy", label: "Privacy & telemetry", icon: <Lock size={12} />, group: "System" },
  { id: "logs", label: "Logs", icon: <FileText size={12} />, group: "System" },
  { id: "about", label: "About", icon: <Info size={12} />, group: "System" },
];

const SECTION_GROUPS = ["Workspace", "Capture", "Output", "Connections", "System"] as const;

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
  const loading = useAppSettingsStore((s) => s.loading);
  const loadError = useAppSettingsStore((s) => s.loadError);
  const resetTarget = RESET_CATEGORY[section];
  const activeSection = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];
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
      <div className="sc-toolbar sc-window-chrome">
        <div className="sc-toolbar-title">Settings</div>
        <ScBadge tone="muted">Workspace · Local</ScBadge>
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
          {SECTION_GROUPS.map((group) => (
            <div key={group} className="mb-3">
              <div className="sc-nav-label">{group}</div>
              {SECTIONS.filter((item) => item.group === group).map((s) => (
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
            </div>
          ))}
        </nav>

        <div className="sc-scroll flex-1">
          <div className="sticky top-0 z-10 flex items-center border-b border-[var(--sc-border)] bg-[var(--sc-bg)] px-8 py-3">
            <div>
              <div className="text-[13px] font-semibold text-[var(--sc-text)]">
                {activeSection.label}
              </div>
              <div className="mt-0.5 text-[12px] text-[var(--sc-text-3)]">
                {loading
                  ? "Loading settings…"
                  : loadError
                    ? "Settings could not be loaded"
                    : "Changes save automatically"}
              </div>
            </div>
            <span className="sc-spacer" />
            {resetTarget && settings ? (
              <ScButton size="sm" variant="ghost" onClick={() => void resetActive()}>
                Reset {activeSection.label}
              </ScButton>
            ) : null}
          </div>
          <PageContentTransition style={{ padding: "24px 32px" }}>
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
      </div>
    </main>
  );
}
