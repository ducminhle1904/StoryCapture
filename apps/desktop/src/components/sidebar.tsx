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
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

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

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      // localStorage unavailable
    }
  }, [collapsed]);

  const visibleItems = NAV_ITEMS.filter((item) =>
    isVisible(item, location.pathname),
  );

  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]"
      style={{ width: collapsed ? 48 : 200 }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-1 px-1.5 pt-2">
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
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                active
                  ? "bg-[var(--color-accent-primary)]/12 text-[var(--color-fg-primary)]"
                  : "text-[var(--color-fg-secondary)] hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
              }`}
            >
              <Icon
                size={18}
                className={
                  active
                    ? "text-[var(--color-accent-primary)]"
                    : "text-[var(--color-fg-muted)]"
                }
              />
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    className="truncate whitespace-nowrap"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          );
        })}
      </div>

      {/* Collapse toggle at bottom */}
      <div className="border-t border-[var(--color-border-subtle)] px-1.5 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[var(--color-fg-secondary)] transition-colors hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
        >
          {collapsed ? (
            <PanelLeft size={18} className="text-[var(--color-fg-muted)]" />
          ) : (
            <PanelLeftClose
              size={18}
              className="text-[var(--color-fg-muted)]"
            />
          )}
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                className="truncate whitespace-nowrap"
              >
                Collapse
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>
    </nav>
  );
}
