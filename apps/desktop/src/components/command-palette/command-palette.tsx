import { Command } from "cmdk";
import { Circle, Clapperboard, Home, Plus, Search, Settings as SettingsIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useLocation, useNavigate } from "react-router-dom";
import { GLOBAL_SHORTCUTS } from "@/lib/shortcuts";
import { useDashboardStore } from "@/state/projects";

type NavigateFn = ReturnType<typeof useNavigate>;

interface PaletteActions {
  navigate: NavigateFn;
  requestNewProject: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  group: "Navigate" | "Actions";
  icon: React.ReactNode;
  kbd?: string;
  run: (ctx: PaletteActions) => void;
}

const GLOBAL_ITEMS: PaletteItem[] = [
  {
    id: "dashboard",
    label: "Go to Projects",
    group: "Navigate",
    icon: <Home size={13} />,
    run: ({ navigate }) => navigate("/"),
  },
  {
    id: "settings",
    label: "Open Settings",
    group: "Navigate",
    icon: <SettingsIcon size={13} />,
    kbd: GLOBAL_SHORTCUTS.find((s) => s.id === "settings")?.keys,
    run: ({ navigate }) => navigate("/settings"),
  },
  {
    id: "new",
    label: "New Story…",
    group: "Actions",
    icon: <Plus size={13} />,
    kbd: GLOBAL_SHORTCUTS.find((s) => s.id === "new-story")?.keys,
    run: ({ navigate, requestNewProject }) => {
      navigate("/");
      requestNewProject();
    },
  },
];

export function projectIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/(?:editor|recorder|post-production)\/([^/?#]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function projectItems(projectId: string): PaletteItem[] {
  const encodedId = encodeURIComponent(projectId);
  return [
    {
      id: "author",
      label: "Open Author",
      group: "Navigate",
      icon: <Clapperboard size={13} />,
      run: ({ navigate }) => navigate(`/editor/${encodedId}`),
    },
    {
      id: "record",
      label: "Open Recorder",
      group: "Actions",
      icon: <Circle size={13} />,
      kbd: GLOBAL_SHORTCUTS.find((s) => s.id === "record")?.keys,
      run: ({ navigate }) => navigate(`/recorder/${encodedId}`),
    },
    {
      id: "edit",
      label: "Open Edit",
      group: "Navigate",
      icon: <Clapperboard size={13} />,
      kbd: GLOBAL_SHORTCUTS.find((s) => s.id === "export")?.keys,
      run: ({ navigate }) => navigate(`/post-production/${encodedId}`),
    },
  ];
}

export function CommandPalette() {
  const open = useDashboardStore((s) => s.paletteOpen);
  const setOpen = useDashboardStore((s) => s.setPaletteOpen);
  const navigate = useNavigate();
  const location = useLocation();
  const requestNewProject = useDashboardStore((s) => s.requestNewProject);
  const projectId = projectIdFromPathname(location.pathname);

  useHotkeys(
    "mod+k",
    (e) => {
      e.preventDefault();
      setOpen(!open);
    },
    { enableOnFormTags: true, preventDefault: true },
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  const runItem = useCallback(
    (item: PaletteItem) => {
      item.run({ navigate, requestNewProject });
      setOpen(false);
    },
    [navigate, requestNewProject, setOpen],
  );

  useHotkeys(
    "mod+n",
    (e) => {
      e.preventDefault();
      navigate("/");
      requestNewProject();
    },
    { enableOnFormTags: true },
  );
  useHotkeys(
    "mod+e",
    (e) => {
      if (!projectId) return;
      e.preventDefault();
      navigate(`/post-production/${encodeURIComponent(projectId)}`);
    },
    { enableOnFormTags: true },
  );
  useHotkeys(
    "mod+comma",
    (e) => {
      e.preventDefault();
      navigate("/settings");
    },
    { enableOnFormTags: true },
  );
  useHotkeys(
    "mod+shift+r",
    (e) => {
      if (!projectId) return;
      e.preventDefault();
      navigate(`/recorder/${encodeURIComponent(projectId)}`);
    },
    { enableOnFormTags: true },
  );

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    const items = projectId ? [...GLOBAL_ITEMS, ...projectItems(projectId)] : GLOBAL_ITEMS;
    for (const it of items) {
      const list = map.get(it.group) ?? [];
      list.push(it);
      map.set(it.group, list);
    }
    return Array.from(map.entries());
  }, [projectId]);

  if (!open) return null;
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[200] grid place-items-center backdrop-blur-md"
          style={{ background: "rgba(0,0,0,0.4)" }}
        >
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="sc-palette w-[720px] max-w-[90%] overflow-hidden"
            style={{
              background: "var(--sc-surface)",
              border: "1px solid var(--sc-border-2)",
              borderRadius: "var(--sc-r-xl)",
              boxShadow: "var(--sc-sh-pop)",
            }}
          >
            <Command
              label="Command palette"
              shouldFilter
              onKeyDownCapture={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
            >
              <div
                className="flex items-center gap-[10px] px-4 py-3"
                style={{ borderBottom: "1px solid var(--sc-border)" }}
              >
                <Search size={15} style={{ color: "var(--sc-text-4)" }} />
                <Command.Input
                  autoFocus
                  placeholder="Type a command or search…"
                  className="flex-1 bg-transparent text-sm outline-none"
                  style={{ color: "var(--sc-text)" }}
                />
                <span className="sc-kbd">esc</span>
              </div>
              <Command.List className="max-h-[480px] overflow-y-auto p-1.5">
                <Command.Empty
                  className="px-4 py-8 text-center text-xs"
                  style={{ color: "var(--sc-text-4)" }}
                >
                  No commands found.
                </Command.Empty>
                {groups.map(([group, items]) => (
                  <Command.Group
                    key={group}
                    heading={group}
                    className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em]"
                    style={{ ["--cmdk-group-heading-color" as string]: "var(--sc-text-4)" }}
                  >
                    {items.map((it) => (
                      <Command.Item
                        key={it.id}
                        value={`${it.label} ${it.id}`}
                        onSelect={() => runItem(it)}
                        className="flex cursor-default items-center gap-2.5 rounded-[var(--sc-r-md)] px-2.5 py-2 text-[12.5px] data-[selected=true]:bg-[var(--sc-hover)]"
                        style={{ color: "var(--sc-text)" }}
                      >
                        <span className="w-4" style={{ color: "var(--sc-text-3)" }}>
                          {it.icon}
                        </span>
                        <span className="flex-1">{it.label}</span>
                        {it.kbd ? <span className="sc-kbd">{it.kbd}</span> : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
              <div
                className="flex items-center gap-3.5 px-3.5 py-2 text-[10.5px]"
                style={{ borderTop: "1px solid var(--sc-border)", color: "var(--sc-text-4)" }}
              >
                <span>
                  <span className="sc-kbd">↑↓</span> navigate
                </span>
                <span>
                  <span className="sc-kbd">↵</span> select
                </span>
                <span className="ml-auto">Powered by fuzzy search</span>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
