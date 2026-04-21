import { useState, type ReactNode } from "react";
import {
  Download,
  Info,
  Key,
  Keyboard,
  Lock,
  Monitor,
  Settings as SettingsIcon,
  UserCircle,
} from "lucide-react";
import { ScBadge, ScButton } from "@storycapture/ui";

import { PageContentTransition } from "@/components/page-content-transition";
import { AccountsPage } from "@/features/settings/AccountsPage";
import { GeneralCategory } from "@/features/settings/categories/general-category";
import { ApiKeysCategory } from "@/features/settings/categories/api-keys-category";
import { CaptureCategory } from "@/features/settings/categories/capture-category";
import { RenderCategory } from "@/features/settings/categories/render-category";
import { KeyboardCategory } from "@/features/settings/categories/keyboard-category";
import { PrivacyCategory } from "@/features/settings/categories/privacy-category";
import { AboutCategory } from "@/features/settings/categories/about-category";

type SectionId =
  | "general"
  | "keys"
  | "capture"
  | "render"
  | "kbd"
  | "privacy"
  | "about"
  | "accounts";

interface Section {
  id: SectionId;
  label: string;
  icon: ReactNode;
}

// 7 mock categories + `accounts` which owns StoryCapture-specific surfaces
// (Web account, Updates, Automation) that the mock doesn't model.
const SECTIONS: Section[] = [
  { id: "general", label: "General", icon: <SettingsIcon size={12} /> },
  { id: "keys", label: "API keys", icon: <Key size={12} /> },
  { id: "capture", label: "Capture backend", icon: <Monitor size={12} /> },
  { id: "render", label: "Render defaults", icon: <Download size={12} /> },
  { id: "kbd", label: "Keyboard", icon: <Keyboard size={12} /> },
  { id: "privacy", label: "Privacy & telemetry", icon: <Lock size={12} /> },
  { id: "about", label: "About", icon: <Info size={12} /> },
  { id: "accounts", label: "Accounts", icon: <UserCircle size={12} /> },
];

export default function SettingsRoute() {
  const [section, setSection] = useState<SectionId>("keys");

  return (
    <main
      id="main-content"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Settings</div>
        <ScBadge tone="muted">Workspace · Local</ScBadge>
        <span className="sc-spacer" />
        <ScButton
          size="sm"
          variant="ghost"
          disabled
          title="Per-category reset coming soon"
        >
          Reset to defaults
        </ScButton>
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
                color: "inherit",
                cursor: "default",
              }}
              aria-current={section === s.id ? "page" : undefined}
            >
              <span
                style={{
                  width: 14,
                  display: "grid",
                  placeItems: "center",
                  color:
                    section === s.id ? "var(--sc-accent-400)" : "var(--sc-text-3)",
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
          {section === "about" && <AboutCategory />}
          {section === "accounts" && <AccountsPage />}
        </PageContentTransition>
      </div>
    </main>
  );
}
