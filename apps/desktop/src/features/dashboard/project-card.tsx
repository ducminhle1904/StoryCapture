import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Card as AstryxCard } from "@astryxdesign/core/Card";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Clock, MoreHorizontal, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Project } from "@/ipc/projects";
import { relativeTime } from "@/lib/utils";
import { projectAccent } from "./hash-accent";

interface ProjectCardProps {
  project: Project;
  sessionCount?: number;
  onOpen: (id: string) => void;
  onRemove?: (project: Project) => Promise<void> | void;
  removePending?: boolean;
}

function ThumbMock({ hue, hash }: { hue: number; hash: string }) {
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "16/10",
        borderRadius: "var(--radius-element)",
        background: `
          radial-gradient(ellipse 60% 80% at 20% 10%, oklch(0.45 0.12 ${hue}) 0%, transparent 60%),
          radial-gradient(ellipse 80% 60% at 80% 100%, oklch(0.32 0.10 ${(hue + 40) % 360}) 0%, transparent 60%),
          linear-gradient(180deg, oklch(0.18 0.04 ${hue}), oklch(0.12 0.02 ${hue}))`,
        overflow: "hidden",
        border: "1px solid var(--color-border-emphasized)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "14% 10% 14% 10%",
          background: "oklch(0.97 0.004 80)",
          borderRadius: 3,
          boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            height: 10,
            background: "oklch(0.93 0.004 80)",
            display: "flex",
            alignItems: "center",
            gap: 3,
            padding: "0 4px",
            borderBottom: "0.5px solid #0001",
          }}
        >
          <span style={{ width: 2, height: 2, borderRadius: 99, background: "#ff5f57" }} />
          <span style={{ width: 2, height: 2, borderRadius: 99, background: "#febc2e" }} />
          <span style={{ width: 2, height: 2, borderRadius: 99, background: "#28c840" }} />
        </div>
        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "30% 1fr",
            gap: 3,
            padding: 4,
          }}
        >
          <div style={{ background: "oklch(0.88 0.004 80)", borderRadius: 2 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div
              style={{
                height: 6,
                background: `oklch(0.78 0.14 ${hue})`,
                borderRadius: 2,
                width: "70%",
              }}
            />
            <div style={{ height: 3, background: "oklch(0.85 0.004 80)", borderRadius: 2 }} />
            <div
              style={{
                height: 3,
                background: "oklch(0.85 0.004 80)",
                borderRadius: 2,
                width: "80%",
              }}
            />
            <div
              style={{
                flex: 1,
                background:
                  "repeating-linear-gradient(135deg, oklch(0.88 0.004 80) 0 3px, oklch(0.94 0.004 80) 3px 6px)",
                borderRadius: 2,
              }}
            />
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          fontFamily: "var(--font-family-code)",
          fontSize: 9,
          color: "rgba(255,255,255,0.6)",
          background: "rgba(0,0,0,0.4)",
          padding: "1px 4px",
          borderRadius: 3,
        }}
      >
        #{hash}
      </div>
    </div>
  );
}

export function ProjectCard({
  project,
  sessionCount,
  onOpen,
  onRemove,
  removePending = false,
}: ProjectCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { hue, hash } = projectAccent(project.id);
  const subtitle =
    sessionCount && sessionCount > 0
      ? `${sessionCount} session${sessionCount === 1 ? "" : "s"}`
      : "No sessions yet";
  // Scene/duration metadata placeholder — no scene model yet.
  const metaLine = "— scenes · —:—";
  const hasRemoveAction = Boolean(onRemove);

  const confirmRemove = async () => {
    if (!onRemove) return;
    try {
      await onRemove(project);
      setConfirmOpen(false);
    } catch {
      // The caller owns the error toast; keep the confirmation open for retry.
    }
  };

  return (
    <>
      <AstryxCard
        role="button"
        tabIndex={0}
        aria-label={`Open project ${project.name}`}
        onClick={() => onOpen(project.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(project.id);
          }
        }}
        style={{ padding: 10, cursor: "default" }}
        className="story-project-card"
      >
        {project.thumbnail_path ? (
          <img
            src={convertFileSrc(project.thumbnail_path)}
            alt=""
            style={{
              aspectRatio: "16/10",
              width: "100%",
              objectFit: "cover",
              borderRadius: "var(--radius-element)",
              border: "1px solid var(--color-border-emphasized)",
            }}
          />
        ) : (
          <ThumbMock hue={hue} hash={hash} />
        )}
        <div
          style={{
            padding: "10px 4px 2px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {project.name}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-disabled)", marginTop: 2 }}>
              {metaLine}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-disabled)", marginTop: 1 }}>
              {subtitle}
            </div>
          </div>
          <AstryxBadge variant="neutral" label="Draft" />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 4px 0",
            borderTop: "1px solid var(--color-border)",
            marginTop: 8,
            fontSize: 11,
            color: "var(--color-text-disabled)",
          }}
        >
          <Clock size={11} aria-hidden="true" />
          {relativeTime(project.last_opened_at)}
          <span style={{ flex: 1 }} />
          <AstryxButton
            size="sm"
            variant="ghost"
            icon={<Play size={11} aria-hidden="true" />}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(project.id);
            }}
            aria-label={`Play ${project.name}`}
            label={`Play ${project.name}`}
          >
            Play
          </AstryxButton>
          {hasRemoveAction ? (
            <AstryxButton
              size="sm"
              isIconOnly
              variant="ghost"
              icon={<Trash2 size={14} aria-hidden="true" />}
              isDisabled={removePending}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmOpen(true);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={`Remove ${project.name} from dashboard`}
              tooltip="Remove from dashboard"
              label={`Remove ${project.name} from dashboard`}
            />
          ) : (
            <AstryxButton
              size="sm"
              variant="ghost"
              icon={<MoreHorizontal size={14} aria-hidden="true" />}
              isDisabled
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={`More actions for ${project.name} (coming soon)`}
              tooltip="More actions coming soon"
              label={`More actions for ${project.name} (coming soon)`}
            />
          )}
        </div>
      </AstryxCard>

      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove project?"
        description={`Remove “${project.name}” from this dashboard. The project folder stays on disk.`}
        cancelLabel="Cancel"
        actionLabel="Remove"
        actionVariant="destructive"
        isActionLoading={removePending}
        onAction={() => void confirmRemove()}
      />
    </>
  );
}
