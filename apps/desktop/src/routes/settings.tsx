import { useState, type ReactNode } from "react";
import { UserCircle } from "lucide-react";

import { PageContentTransition } from "@/components/page-content-transition";
import { AccountsPage } from "@/features/settings/AccountsPage";

type SectionId = "accounts";

interface Section {
  id: SectionId;
  label: string;
  icon: ReactNode;
}

// Only categories wired to real data ship. Appearance lands in Wave 5.
const SECTIONS: Section[] = [
  { id: "accounts", label: "Accounts", icon: <UserCircle size={12} /> },
];

export default function SettingsRoute() {
  const [section, setSection] = useState<SectionId>("accounts");

  return (
    <main
      id="main-content"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div className="sc-toolbar">
        <div className="sc-toolbar-title">Settings</div>
        <span className="sc-spacer" />
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
                    section === s.id
                      ? "var(--sc-accent-400)"
                      : "var(--sc-text-3)",
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
          {section === "accounts" && <AccountsPage />}
        </PageContentTransition>
      </div>
    </main>
  );
}
