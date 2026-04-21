import { useLocation, useNavigate } from "react-router-dom";
import {
  Home,
  Code,
  Scissors,
  Download,
  Film,
  Settings as SettingsIcon,
  Search,
  Circle,
} from "lucide-react";

import { BrandMark } from "@/components/brand";

interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  path?: string;
  matchPattern?: RegExp;
  disabled?: boolean;
}

interface NavGroup {
  group: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    group: "Workspace",
    items: [
      { id: "dashboard", label: "Projects", icon: Home, path: "/" },
      {
        id: "editor",
        label: "Story Editor",
        icon: Code,
        path: "/editor",
        matchPattern: /^\/editor(\/|$)/,
      },
      {
        id: "post",
        label: "Post-Production",
        icon: Scissors,
        path: "/post-production",
        matchPattern: /^\/post-production(\/|$)/,
      },
    ],
  },
  {
    group: "Output",
    items: [
      { id: "export", label: "Render & Export", icon: Download, disabled: true },
      { id: "renders", label: "Recent Renders", icon: Film, disabled: true },
    ],
  },
  {
    group: "System",
    items: [
      {
        id: "settings",
        label: "Settings",
        icon: SettingsIcon,
        path: "/settings",
        matchPattern: /^\/settings/,
      },
    ],
  },
];

function isActive(item: NavItem, pathname: string): boolean {
  if (item.matchPattern) return item.matchPattern.test(pathname);
  if (item.path) return pathname === item.path;
  return false;
}

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();

  const openPalette = () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }),
    );
  };

  const startRecord = () => navigate("/recorder");

  return (
    <nav aria-label="Main navigation" className="sc-nav" style={{ width: 224 }}>
      {/* Brand */}
      <div className="sc-brand">
        <BrandMark size={28} className="rounded-md" />
        <div>
          <div className="sc-brand-name">StoryCapture</div>
          <div className="text-[10.5px] text-[var(--sc-text-4)] mt-[1px]">v0.4.2 · Tauri</div>
        </div>
      </div>

      {/* Search & commands */}
      <div className="px-[10px] pb-2">
        <button
          type="button"
          onClick={openPalette}
          className="sc-btn w-full justify-between"
          style={{ background: "var(--sc-surface-2)" }}
        >
          <span className="inline-flex items-center gap-[7px] text-[var(--sc-text-3)]">
            <Search size={13} /> Search &amp; commands
          </span>
          <span className="sc-kbd">⌘K</span>
        </button>
      </div>

      {/* Nav groups */}
      <div className="sc-scroll flex-1 pb-[10px]">
        {NAV.map((g) => (
          <div key={g.group} className="sc-nav-section">
            <div className="sc-nav-label">{g.group}</div>
            {g.items.map((it) => {
              const active = isActive(it, location.pathname);
              const Icon = it.icon;
              return (
                <div
                  key={it.id}
                  role="button"
                  tabIndex={it.disabled ? -1 : 0}
                  aria-disabled={it.disabled || undefined}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    if (it.disabled) return;
                    if (it.path) navigate(it.path);
                  }}
                  onKeyDown={(e) => {
                    if (it.disabled) return;
                    if ((e.key === "Enter" || e.key === " ") && it.path) {
                      e.preventDefault();
                      navigate(it.path);
                    }
                  }}
                  className={`sc-nav-item ${active ? "active" : ""}`}
                  style={it.disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                >
                  <span
                    className="grid w-[14px] place-items-center"
                    style={{ color: active ? "var(--sc-accent-400)" : "var(--sc-text-3)" }}
                  >
                    <Icon size={14} />
                  </span>
                  <span>{it.label}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Record + user footer */}
      <div className="p-[10px] border-t border-[var(--sc-border)]">
        <button
          type="button"
          onClick={startRecord}
          className="sc-btn primary w-full justify-center mb-[10px]"
        >
          <Circle size={9} fill="currentColor" /> Record
        </button>
        <div className="flex items-center gap-2">
          <div className="sc-avatar">SC</div>
          <div className="min-w-0">
            <div className="text-[12px] font-medium truncate">Local user</div>
            <div className="text-[10.5px] text-[var(--sc-text-4)]">Local workspace</div>
          </div>
          <SettingsIcon
            size={12}
            className="ml-auto text-[var(--sc-text-4)] cursor-pointer"
            onClick={() => navigate("/settings")}
          />
        </div>
      </div>
    </nav>
  );
}
