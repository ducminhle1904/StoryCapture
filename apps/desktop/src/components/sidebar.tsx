import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Home,
  FileText,
  Film,
  Video,
  Settings,
  PanelLeftClose,
  PanelLeft,
  Sun,
  Moon,
} from "lucide-react";
import { BrandMark } from "@/components/brand";
import { getTheme, toggleTheme, type Theme } from "@/lib/theme";

const STORAGE_KEY = "storycapture-sidebar-collapsed";

interface NavItem {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  path: string;
  /** When true, only show if the current route matches this pattern */
  contextual?: boolean;
  matchPattern?: RegExp;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    icon: Home,
    path: "/",
  },
  {
    label: "Editor",
    icon: FileText,
    path: "/editor",
    contextual: true,
    matchPattern: /^\/editor\//,
  },
  {
    label: "Post-Production",
    icon: Film,
    path: "/post-production",
    contextual: true,
    matchPattern: /^\/post-production\//,
  },
  {
    label: "Recorder",
    icon: Video,
    path: "/recorder",
    contextual: true,
    matchPattern: /^\/recorder\//,
  },
  {
    label: "Settings",
    icon: Settings,
    path: "/settings",
  },
];

function isActive(item: NavItem, pathname: string): boolean {
  if (item.matchPattern) {
    return item.matchPattern.test(pathname);
  }
  return pathname === item.path;
}

function isVisible(item: NavItem, pathname: string): boolean {
  if (!item.contextual) return true;
  // Show contextual items when on that route
  return item.matchPattern?.test(pathname) ?? false;
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<Theme>(() => getTheme());

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      // localStorage unavailable
    }
  }, [collapsed]);

  const handleToggleTheme = () => {
    const next = toggleTheme();
    setTheme(next);
  };

  const visibleItems = NAV_ITEMS.filter((item) =>
    isVisible(item, location.pathname),
  );

  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col overflow-hidden border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      style={{ width: collapsed ? 48 : 200 }}
    >
      {/* Branding — logo + wordmark */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 px-3">
        <BrandMark size={collapsed ? 22 : 24} />
        <span
          aria-hidden={collapsed}
          className={`grid overflow-hidden transition-[grid-template-columns,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
            collapsed
              ? "pointer-events-none grid-cols-[0fr] opacity-0"
              : "grid-cols-[1fr] opacity-100"
          }`}
        >
          <span
            className="min-w-0 whitespace-nowrap text-sm font-semibold tracking-[-0.02em] text-[var(--color-fg-primary)]"
            style={{ fontFamily: "'Outfit Variable', 'Outfit', sans-serif" }}
          >
            storycapture
          </span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 px-1.5">
        {visibleItems.map((item) => {
          const active = isActive(item, location.pathname);
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => {
                // For contextual items, stay on the current route (already there)
                // For non-contextual items, navigate
                if (!item.contextual) {
                  navigate(item.path);
                }
              }}
              title={collapsed ? item.label : undefined}
              className={`flex items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-sm transition-colors ${
                active
                  ? "bg-[var(--color-accent-primary)]/12 text-[var(--color-fg-primary)]"
                  : "text-[var(--color-fg-secondary)] hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
              }`}
            >
              <Icon
                size={18}
                className={`shrink-0 ${
                  active
                    ? "text-[var(--color-accent-primary)]"
                    : "text-[var(--color-fg-muted)]"
                }`}
              />
              <span
                aria-hidden={collapsed}
                className={`grid overflow-hidden transition-[grid-template-columns,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
                  collapsed
                    ? "pointer-events-none grid-cols-[0fr] opacity-0"
                    : "grid-cols-[1fr] opacity-100"
                }`}
              >
                <span className="min-w-0 truncate whitespace-nowrap">
                  {item.label}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Footer: theme toggle + collapse */}
      <div className="flex flex-col gap-0.5 border-t border-[var(--color-border-subtle)] px-1.5 py-2">
        {/* Theme toggle */}
        <button
          type="button"
          onClick={handleToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-sm text-[var(--color-fg-secondary)] transition-colors hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
        >
          <span className="relative grid h-[18px] w-[18px] shrink-0 place-items-center">
            <Sun
              size={18}
              className={`absolute text-[var(--color-fg-muted)] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                theme === "dark"
                  ? "rotate-90 scale-0 opacity-0"
                  : "rotate-0 scale-100 opacity-100"
              }`}
              aria-hidden="true"
            />
            <Moon
              size={18}
              className={`absolute text-[var(--color-fg-muted)] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                theme === "dark"
                  ? "rotate-0 scale-100 opacity-100"
                  : "-rotate-90 scale-0 opacity-0"
              }`}
              aria-hidden="true"
            />
          </span>
          <span
            aria-hidden={collapsed}
            className={`grid overflow-hidden transition-[grid-template-columns,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              collapsed
                ? "pointer-events-none grid-cols-[0fr] opacity-0"
                : "grid-cols-[1fr] opacity-100"
            }`}
          >
            <span className="min-w-0 truncate whitespace-nowrap">
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </span>
          </span>
        </button>

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-sm text-[var(--color-fg-secondary)] transition-colors hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
        >
          {collapsed ? (
            <PanelLeft
              size={18}
              className="shrink-0 text-[var(--color-fg-muted)]"
            />
          ) : (
            <PanelLeftClose
              size={18}
              className="shrink-0 text-[var(--color-fg-muted)]"
            />
          )}
          <span
            aria-hidden={collapsed}
            className={`grid overflow-hidden transition-[grid-template-columns,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              collapsed
                ? "pointer-events-none grid-cols-[0fr] opacity-0"
                : "grid-cols-[1fr] opacity-100"
            }`}
          >
            <span className="min-w-0 truncate whitespace-nowrap">Collapse</span>
          </span>
        </button>
      </div>
    </nav>
  );
}
