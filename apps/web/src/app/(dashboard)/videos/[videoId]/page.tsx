"use client";

import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { EmbedCode } from "@/components/embed-code";
import { PrivacyToggle } from "@/components/privacy-toggle";
import { VideoPlayer } from "@/components/video-player";
import { useTRPC } from "@/trpc/client";

/**
 * Video detail/management page (auth-gated via dashboard layout).
 * Shows video preview, privacy toggle, slug editor, embed code, delete button.
 */
export default function VideoDetailPage({ params }: { params: Promise<{ videoId: string }> }) {
  // Unwrap params via use() for Next.js 15 async params
  const { videoId } = use(params);

  return <VideoDetailContent videoId={videoId} />;
}

import { use } from "react";

function VideoDetailContent({ videoId }: { videoId: string }) {
  const trpc = useTRPC();

  const { data: video, refetch } = useSuspenseQuery(trpc.video.getById.queryOptions({ videoId }));

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-50">{video.projectName}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {video.fileName} &middot; {(video.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
        </p>
      </div>

      {/* Video preview */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Preview</h2>
        <div className="max-w-2xl">
          <VideoPlayer src={video.videoUrl} poster={video.thumbnailUrl} className="rounded-lg" />
        </div>
      </section>

      {/* Privacy toggle */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Privacy</h2>
        <PrivacyToggleSection
          videoId={video.id}
          initialIsPublic={video.isPublic}
          onChanged={refetch}
        />
      </section>

      {/* Slug editor */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Share URL</h2>
        <SlugEditor videoId={video.id} currentSlug={video.slug} onChanged={refetch} />
      </section>

      {/* Embed code */}
      <section>
        <EmbedCode
          videoId={video.id}
          baseUrl={
            typeof window !== "undefined" ? window.location.origin : "https://storycapture.app"
          }
        />
      </section>

      {/* Analytics */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Analytics</h2>
        <a
          href={`/analytics/${videoId}`}
          className="inline-flex items-center gap-1 text-sm text-zinc-400 underline transition-colors hover:text-zinc-200"
        >
          View analytics
        </a>
      </section>

      {/* Delete */}
      <section className="border-t border-zinc-800 pt-6">
        <DeleteVideoSection videoId={video.id} />
      </section>
    </div>
  );
}

// --- Privacy toggle wired to tRPC ---

function PrivacyToggleSection({
  videoId,
  initialIsPublic,
  onChanged,
}: {
  videoId: string;
  initialIsPublic: boolean;
  onChanged: () => void;
}) {
  const trpc = useTRPC();
  const mutation = useMutation(trpc.video.updatePrivacy.mutationOptions());

  const handleToggle = useCallback(
    async (vid: string, isPublic: boolean) => {
      await mutation.mutateAsync({ videoId: vid, isPublic });
      onChanged();
    },
    [mutation, onChanged],
  );

  return (
    <PrivacyToggle videoId={videoId} initialIsPublic={initialIsPublic} onToggle={handleToggle} />
  );
}

// --- Slug editor ---

function SlugEditor({
  videoId,
  currentSlug,
  onChanged,
}: {
  videoId: string;
  currentSlug: string;
  onChanged: () => void;
}) {
  const trpc = useTRPC();
  const [slug, setSlug] = useState(currentSlug);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation(trpc.video.updateSlug.mutationOptions());

  const handleSave = useCallback(async () => {
    if (slug === currentSlug) return;
    setError(null);

    try {
      await mutation.mutateAsync({ videoId, newSlug: slug });
      onChanged();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update slug.";
      setError(message);
    }
  }, [slug, currentSlug, videoId, mutation, onChanged]);

  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://storycapture.app";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-500">{baseUrl}/watch/</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          placeholder="my-video-slug"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={slug === currentSlug || mutation.isPending}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? "Saving..." : "Save"}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <p className="text-xs text-zinc-500">
        Lowercase letters, numbers, and hyphens only. 3-60 characters.
      </p>
    </div>
  );
}

// --- Delete video ---

function DeleteVideoSection({ videoId }: { videoId: string }) {
  const trpc = useTRPC();
  const [confirming, setConfirming] = useState(false);

  const mutation = useMutation(trpc.video.deleteVideo.mutationOptions());

  const handleDelete = useCallback(async () => {
    await mutation.mutateAsync({ videoId });
    // Redirect to dashboard after deletion
    window.location.href = "/";
  }, [videoId, mutation]);

  if (confirming) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-red-400">
          Are you sure you want to delete this video? This action cannot be undone.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleDelete}
            disabled={mutation.isPending}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {mutation.isPending ? "Deleting..." : "Yes, delete"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-2 text-sm font-medium text-zinc-300">Danger Zone</h2>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-red-800 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-950"
      >
        Delete Video
      </button>
    </div>
  );
}
