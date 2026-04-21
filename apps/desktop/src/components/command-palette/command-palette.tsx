import { Command } from "cmdk";
import {
  Code,
  Download,
  FileText,
  Film,
  Grid,
  Home,
  Layers,
  Search,
  Settings as SettingsIcon,
  Video,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate } from "react-router-dom";

interface PaletteItem {
  id: string;
  label: string;
  group: string;
  path: string;
  icon: React.ReactNode;
  kbd?: string;
}

const ITEMS: PaletteItem[] = [
  { id: "dashboard", label: "Go to Projects", group: "Navigate", path: "/", icon: <Home size={13} /> },
  { id: "editor", label: "Go to Editor", group: "Navigate", path: "/editor", icon: <Code size={13} /> },
  { id: "post", label: "Go to Post-Production", group: "Navigate", path: "/post-production", icon: <Film size={13} /> },
  { id: "recorder", label: "Go to Recorder", group: "Navigate", path: "/recorder", icon: <Video size={13} /> },
  { id: "settings", label: "Open Settings", group: "Navigate", path: "/settings", icon: <SettingsIcon size={13} />, kbd: "⌘," },
  { id: "tokens", label: "Open Design Tokens", group: "Design System", path: "/_design-system/tokens", icon: <Layers size={13} /> },
  { id: "components", label: "Open Component Samples", group: "Design System", path: "/_design-system/components", icon: <Grid size={13} /> },
  { id: "docs", label: "Open DSL reference", group: "Help", path: "/_design-system/tokens", icon: <FileText size={13} /> },
  { id: "export", label: "Render & Export…", group: "Actions", path: "/post-production", icon: <Download size={13} />, kbd: "⌘E" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useHotkeys(
    "mod+k",
    (e) => {
      e.preventDefault();
      setOpen((o) => !o);
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
  }, [open]);

  const run = useCallback(
    (path: string) => {
      navigate(path);
      setOpen(false);
    },
    [navigate],
  );

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const it of ITEMS) {
      const list = map.get(it.group) ?? [];
      list.push(it);
      map.set(it.group, list);
    }
    return Array.from(map.entries());
  }, []);

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
          className="fixed inset-0 z-[200] grid place-items-start justify-center pt-[120px] backdrop-blur-md"
          style={{ background: "rgba(0,0,0,0.4)" }}
        >
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="sc-palette w-[560px] max-w-[90%] overflow-hidden"
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
              <Command.List className="max-h-[360px] overflow-y-auto p-1.5">
                <Command.Empty className="px-4 py-8 text-center text-xs" style={{ color: "var(--sc-text-4)" }}>
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
                        onSelect={() => run(it.path)}
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
              </div>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
