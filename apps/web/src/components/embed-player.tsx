"use client";

/**
 * Minimal video player for the /embed/[id] iframe page.
 * No chrome, no chapter nav -- just the video element filling the viewport.
 */
export function EmbedPlayer({ src, poster }: { src: string; poster: string | null }) {
  return (
    <video
      src={src}
      poster={poster ?? undefined}
      controls
      playsInline
      autoPlay={false}
      className="h-full w-full object-contain"
    />
  );
}
