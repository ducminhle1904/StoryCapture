"use client";

import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
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
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">{video.projectName}</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          {video.fileName} &middot; {(video.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
        </p>
      </div>

      {/* Video preview */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">Preview</h2>
        <div className="max-w-2xl">
          <VideoPlayer src={video.videoUrl} poster={video.thumbnailUrl} className="rounded-lg" />
        </div>
      </section>

      {/* Privacy toggle */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">Privacy</h2>
        <PrivacyToggleSection
          videoId={video.id}
          initialIsPublic={video.isPublic}
          onChanged={refetch}
        />
      </section>

      {/* Slug editor */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">Share URL</h2>
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
        <h2 className="mb-3 text-sm font-medium text-[var(--color-text-primary)]">Analytics</h2>
        <Button
          href={`/analytics/${videoId}`}
          label="View analytics"
          variant="secondary"
          size="sm"
        />
      </section>

      {/* Delete */}
      <section className="border-t border-[var(--color-border)] pt-6">
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
        <span className="text-sm text-[var(--color-text-secondary)]">{baseUrl}/watch/</span>
        <TextInput
          label="Video slug"
          isLabelHidden
          value={slug}
          onChange={(value) => setSlug(value.toLowerCase())}
          placeholder="my-video-slug"
          width={240}
        />
        <Button
          label="Save"
          variant="primary"
          onClick={handleSave}
          isLoading={mutation.isPending}
          isDisabled={slug === currentSlug || mutation.isPending}
        />
      </div>

      {error && <Banner status="error" title="Could not update share URL" description={error} />}

      <p className="text-xs text-[var(--color-text-secondary)]">
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

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-[var(--color-error)]">Danger Zone</h2>
      <Button label="Delete video" variant="destructive" onClick={() => setConfirming(true)} />
      <AlertDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Delete video?"
        description="This action cannot be undone."
        cancelLabel="Cancel"
        actionLabel="Delete video"
        actionVariant="destructive"
        isActionLoading={mutation.isPending}
        onAction={() => void handleDelete()}
      />
    </div>
  );
}
