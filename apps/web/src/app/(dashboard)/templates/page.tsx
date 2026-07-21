"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { TemplateGrid } from "@/components/template-grid";
import { useTRPC } from "@/trpc/client";

/**
 * Template Marketplace page.
 * Browse curated templates by category and fork them as downloadable .story files.
 */
export default function TemplatesPage() {
  const trpc = useTRPC();
  const [forkResult, setForkResult] = useState<{
    storySource: string;
    fileName: string;
    templateName: string;
  } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);

  const forkMutation = useMutation(
    trpc.template.fork.mutationOptions({
      onSuccess(data) {
        setForkError(null);
        setForkResult(data);
      },
      onError(error) {
        if (error.data?.code === "UNAUTHORIZED") {
          // Redirect unauthenticated users to sign in
          window.location.href = "/sign-in";
          return;
        }
        setForkError(error.message);
      },
    }),
  );

  const handleUseTemplate = useCallback(
    (templateId: string) => {
      forkMutation.mutate({ templateId });
    },
    [forkMutation],
  );

  const handleDownload = useCallback(() => {
    if (!forkResult) return;
    const blob = new Blob([forkResult.storySource], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = forkResult.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [forkResult]);

  const handleCopyToClipboard = useCallback(async () => {
    if (!forkResult) return;
    try {
      await navigator.clipboard.writeText(forkResult.storySource);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = forkResult.storySource;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  }, [forkResult]);

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
          Template Marketplace
        </h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Start with a proven demo pattern. Fork any template into your project.
        </p>
      </div>

      {forkError && (
        <Banner
          status="error"
          title="Failed to fork template"
          description={forkError}
          isDismissable
          onDismiss={() => setForkError(null)}
        />
      )}

      {/* Template grid */}
      <TemplateGrid onUseTemplate={handleUseTemplate} />

      <Dialog
        isOpen={forkResult !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setForkResult(null);
        }}
        purpose="info"
        width="min(672px, calc(100vw - 2rem))"
        maxHeight="calc(100dvh - 2rem)"
        padding={6}
        aria-labelledby="template-forked-title"
      >
        {forkResult && (
          <div>
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h2
                  id="template-forked-title"
                  className="text-lg font-semibold text-[var(--color-text-primary)]"
                >
                  Template Forked
                </h2>
                <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">
                  {forkResult.templateName}
                </p>
              </div>
              <Button
                label="Close dialog"
                isIconOnly
                variant="ghost"
                onClick={() => setForkResult(null)}
                icon={
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                }
              />
            </div>

            {/* Story source preview */}
            <pre className="mt-4 max-h-72 overflow-auto rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-body)] p-4 font-mono text-xs text-[var(--color-text-primary)]">
              <code>{forkResult.storySource}</code>
            </pre>

            {/* Instructions */}
            <p className="mt-3 text-xs text-[var(--color-text-secondary)]">
              Open this file in your StoryCapture desktop app to start customizing.
            </p>

            {/* Actions */}
            <div className="mt-4 flex gap-3">
              <Button
                label="Download .story file"
                variant="primary"
                onClick={handleDownload}
                icon={
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                }
              />
              <Button
                label={copyFeedback ? "Copied!" : "Copy to clipboard"}
                variant="secondary"
                onClick={handleCopyToClipboard}
                icon={
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                }
              />
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
