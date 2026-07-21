import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Kbd as AstryxKbd } from "@astryxdesign/core/Kbd";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import {
  Circle,
  Code,
  Download,
  Film,
  Home,
  Scissors,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { BrandMark } from "@/components/brand";
import { useDashboardStore } from "@/state/projects";

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
  const setPaletteOpen = useDashboardStore((s) => s.setPaletteOpen);

  const openPalette = () => setPaletteOpen(true);

  const startRecord = () => navigate("/recorder");

  return (
    <SideNav
      className="story-window-sidebar"
      style={{ width: 224 }}
      header={
        <div className="flex items-center gap-2 px-3 py-3 text-[var(--color-text-primary)]">
          <BrandMark size={28} className="rounded-md" />
          <div>
            <div className="text-sm font-semibold">StoryCapture</div>
            <div className="text-[var(--color-text-disabled)]" style={{ fontSize: 11 }}>
              Electron desktop
            </div>
          </div>
        </div>
      }
      topContent={
        <div className="px-2 pb-2">
          <AstryxButton
            label="Search and commands"
            variant="secondary"
            icon={<Search size={13} />}
            endContent={<AstryxKbd keys="⌘K" />}
            onClick={openPalette}
            className="w-full justify-between"
          />
        </div>
      }
      footer={
        <div className="px-2 pb-2">
          <AstryxButton
            label="Record"
            variant="primary"
            icon={<Circle size={9} fill="currentColor" />}
            onClick={startRecord}
            className="w-full justify-center"
          />
        </div>
      }
      footerIcons={
        <div className="flex w-full items-center gap-2">
          <div className="grid h-6 w-6 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-on-accent)]">
            SC
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">Local user</div>
            <div className="text-[var(--color-text-disabled)]" style={{ fontSize: 11 }}>
              Local workspace
            </div>
          </div>
          <AstryxButton
            label="Open settings"
            icon={<SettingsIcon size={13} />}
            isIconOnly
            variant="ghost"
            onClick={() => navigate("/settings")}
          />
        </div>
      }
    >
      {NAV.map((group) => (
        <SideNavSection key={group.group} title={group.group}>
          {group.items.map((item) => {
            const active = isActive(item, location.pathname);
            const Icon = item.icon;
            return (
              <SideNavItem
                key={item.id}
                label={item.label}
                icon={<Icon size={14} />}
                isSelected={active}
                isDisabled={item.disabled}
                onClick={() => {
                  if (item.path) navigate(item.path);
                }}
              />
            );
          })}
        </SideNavSection>
      ))}
    </SideNav>
  );
}
