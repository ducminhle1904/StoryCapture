import { motion } from "motion/react";
import { convertFileSrc } from "@tauri-apps/api/core";

import coolOceanSrc from "@/assets/gradients/cool-ocean.png";
import elevenLabsVioletSrc from "@/assets/gradients/elevenlabs-violet.png";
import forestEmeraldSrc from "@/assets/gradients/forest-emerald.png";
import linearSlateSrc from "@/assets/gradients/linear-slate.png";
import runwayDarkSrc from "@/assets/gradients/runway-dark.png";
import warmSunsetSrc from "@/assets/gradients/warm-sunset.png";
import { relativeTime } from "@/lib/utils";
import type { Project } from "@/ipc/projects";

interface ProjectCardProps {
  project: Project;
  onOpen: (id: string) => void;
}

const PLACEHOLDER_BACKGROUNDS = [
  runwayDarkSrc,
  linearSlateSrc,
  warmSunsetSrc,
  coolOceanSrc,
  forestEmeraldSrc,
  elevenLabsVioletSrc,
] as const;

function pickPlaceholderBackground(project: Project): string {
  const seed = `${project.id}:${project.name}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }

  return PLACEHOLDER_BACKGROUNDS[hash % PLACEHOLDER_BACKGROUNDS.length];
}

export function ProjectCard({ project, onOpen }: ProjectCardProps) {
  const placeholderBackground = pickPlaceholderBackground(project);

  return (
    <motion.button
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      onClick={() => onOpen(project.id)}
      aria-label={`Open project ${project.name}`}
      className="brand-panel group flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-2xl)] text-left transition-colors hover:border-[var(--color-border-default)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
    >
      {project.thumbnail_path ? (
        <img
          src={convertFileSrc(project.thumbnail_path)}
          alt=""
          className="aspect-[16/10] w-full object-cover"
        />
      ) : (
        <div
          className="relative aspect-[16/10] w-full overflow-hidden"
          style={{
            backgroundImage: `linear-gradient(180deg, rgba(7, 9, 14, 0.06), rgba(7, 9, 14, 0.48)), url(${placeholderBackground})`,
            backgroundPosition: "center",
            backgroundSize: "cover",
          }}
        >
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(38,37,30,0.03),transparent_42%,rgba(38,37,30,0.06))]" />
        </div>
      )}
      <div className="p-4">
        <h3 className="truncate text-base font-medium text-[var(--color-fg-primary)]">
          {project.name}
        </h3>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {relativeTime(project.last_opened_at)}
        </p>
      </div>
    </motion.button>
  );
}
