import { motion } from "motion/react";
import { Film } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { relativeTime } from "@/lib/utils";
import type { Project } from "@/ipc/projects";

interface ProjectCardProps {
  project: Project;
  onOpen: (id: string) => void;
}

export function ProjectCard({ project, onOpen }: ProjectCardProps) {
  return (
    <motion.button
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      onClick={() => onOpen(project.id)}
      aria-label={`Open project ${project.name}`}
      className="group flex flex-col rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] hover:border-[var(--color-border-default)] transition-colors"
    >
      {project.thumbnail_path ? (
        <img
          src={convertFileSrc(project.thumbnail_path)}
          alt=""
          className="aspect-video object-cover w-full"
        />
      ) : (
        <div className="aspect-video bg-[var(--color-bg-elevated)] grid place-items-center">
          <Film
            className="text-[var(--color-fg-muted)]"
            size={32}
            aria-hidden="true"
          />
        </div>
      )}
      <div className="p-3">
        <h3 className="text-[var(--color-fg-primary)] text-sm font-medium truncate">
          {project.name}
        </h3>
        <p className="text-xs text-[var(--color-fg-muted)] mt-1">
          {relativeTime(project.last_opened_at)}
        </p>
      </div>
    </motion.button>
  );
}
