import {
  CommandPalette as AstryxCommandPalette,
  CommandPaletteInput,
} from "@astryxdesign/core/CommandPalette";
import { Kbd } from "@astryxdesign/core/Kbd";
import { createStaticSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import {
  Circle,
  Code,
  Download,
  Home,
  Plus,
  Scissors,
  Settings as SettingsIcon,
} from "lucide-react";
import { useCallback } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useNavigate } from "react-router-dom";

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

const ITEMS: PaletteItem[] = [
  {
    id: "dashboard",
    label: "Go to Projects",
    group: "Navigate",
    icon: <Home size={13} />,
    run: ({ navigate }) => navigate("/"),
  },
  {
    id: "editor",
    label: "Go to Story Editor",
    group: "Navigate",
    icon: <Code size={13} />,
    run: ({ navigate }) => navigate("/"),
  },
  {
    id: "post",
    label: "Go to Post-Production",
    group: "Navigate",
    icon: <Scissors size={13} />,
    run: ({ navigate }) => navigate("/"),
  },
  {
    id: "export",
    label: "Render & Export…",
    group: "Navigate",
    icon: <Download size={13} />,
    kbd: GLOBAL_SHORTCUTS.find((shortcut) => shortcut.id === "export")?.keys,
    run: ({ navigate }) => navigate("/post-production"),
  },
  {
    id: "settings",
    label: "Open Settings",
    group: "Navigate",
    icon: <SettingsIcon size={13} />,
    kbd: GLOBAL_SHORTCUTS.find((shortcut) => shortcut.id === "settings")?.keys,
    run: ({ navigate }) => navigate("/settings"),
  },
  {
    id: "new",
    label: "New Story…",
    group: "Actions",
    icon: <Plus size={13} />,
    kbd: GLOBAL_SHORTCUTS.find((shortcut) => shortcut.id === "new-story")?.keys,
    run: ({ navigate, requestNewProject }) => {
      navigate("/");
      requestNewProject();
    },
  },
  {
    id: "record",
    label: "Start Recording",
    group: "Actions",
    icon: <Circle size={13} />,
    kbd: GLOBAL_SHORTCUTS.find((shortcut) => shortcut.id === "record")?.keys,
    run: ({ navigate }) => navigate("/recorder"),
  },
];

interface PaletteSearchData {
  command: PaletteItem;
  group: PaletteItem["group"];
}

type PaletteSearchItem = SearchableItem<PaletteSearchData>;

const SEARCH_ITEMS: PaletteSearchItem[] = ITEMS.map((command) => ({
  id: command.id,
  label: command.label,
  auxiliaryData: { command, group: command.group },
}));

const SEARCH_SOURCE = createStaticSource(SEARCH_ITEMS, {
  keywords: (item) => [item.id],
});

export function CommandPalette() {
  const open = useDashboardStore((state) => state.paletteOpen);
  const setOpen = useDashboardStore((state) => state.setPaletteOpen);
  const navigate = useNavigate();
  const requestNewProject = useDashboardStore((state) => state.requestNewProject);

  useHotkeys(
    "mod+k",
    (event) => {
      event.preventDefault();
      setOpen(!open);
    },
    { enableOnFormTags: true, preventDefault: true },
  );

  const runItem = useCallback(
    (itemId: string) => {
      const item = ITEMS.find((candidate) => candidate.id === itemId);
      if (!item) return;
      item.run({ navigate, requestNewProject });
    },
    [navigate, requestNewProject],
  );

  useHotkeys(
    "mod+n",
    (event) => {
      event.preventDefault();
      navigate("/");
      requestNewProject();
    },
    { enableOnFormTags: true },
  );
  useHotkeys(
    "mod+e",
    (event) => {
      event.preventDefault();
      navigate("/post-production");
    },
    { enableOnFormTags: true },
  );
  useHotkeys(
    "mod+comma",
    (event) => {
      event.preventDefault();
      navigate("/settings");
    },
    { enableOnFormTags: true },
  );
  useHotkeys(
    "mod+shift+r",
    (event) => {
      event.preventDefault();
      navigate("/recorder");
    },
    { enableOnFormTags: true },
  );

  return (
    <AstryxCommandPalette<PaletteSearchItem>
      isOpen={open}
      onOpenChange={setOpen}
      searchSource={SEARCH_SOURCE}
      onValueChange={runItem}
      label="Command palette"
      width={720}
      maxHeight={480}
      emptySearchText="No commands found."
      input={
        <CommandPaletteInput
          placeholder="Type a command or search…"
          endContent={<Kbd keys="Esc" />}
        />
      }
      renderItem={(item) => {
        const command = item.auxiliaryData?.command;
        if (!command) return item.label;
        return (
          <div className="flex w-full items-center gap-2.5">
            <span className="w-4 text-[var(--color-text-secondary)]">{command.icon}</span>
            <span className="flex-1">{command.label}</span>
            {command.kbd ? <Kbd keys={command.kbd} /> : null}
          </div>
        );
      }}
    />
  );
}
