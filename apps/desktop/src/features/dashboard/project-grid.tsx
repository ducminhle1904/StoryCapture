import { Plus } from "lucide-react";
import { ScCard } from "@storycapture/ui";

import type { Project } from "@/ipc/projects";
import { ProjectCard } from "./project-card";

interface ProjectGridProps {
  projects: Project[];
  onOpen: (id: string) => void;
  onNewStory: () => void;
}

export function ProjectGrid({ projects, onOpen, onNewStory }: ProjectGridProps) {
  return (
    <div
      role="list"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        gap: 14,
      }}
    >
      {projects.map((p) => (
        <div key={p.id} role="listitem">
          <ProjectCard project={p} onOpen={onOpen} />
        </div>
      ))}
      <ScCard
        role="button"
        tabIndex={0}
        aria-label="Create new story"
        onClick={onNewStory}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onNewStory();
          }
        }}
        style={{
          padding: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 232,
          borderStyle: "dashed",
          borderColor: "var(--sc-border-2)",
          cursor: "default",
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 99,
            background: "var(--sc-surface-3)",
            display: "grid",
            placeItems: "center",
            marginBottom: 10,
          }}
        >
          <Plus size={16} style={{ color: "var(--sc-text-3)" }} aria-hidden="true" />
        </div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>New Story</div>
        <div style={{ fontSize: 11, color: "var(--sc-text-4)", marginTop: 2 }}>
          ⌘N · blank, template, or import .story
        </div>
      </ScCard>
    </div>
  );
}
