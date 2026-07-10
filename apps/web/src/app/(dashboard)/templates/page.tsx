"use client";

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

  const forkMutation = useMutation(
    trpc.template.fork.mutationOptions({
      onSuccess(data) {
        setForkResult(data);
      },
      onError(error) {
        if (error.data?.code === "UNAUTHORIZED") {
          // Redirect unauthenticated users to sign in
          window.location.href = "/sign-in";
          return;
        }
        alert(`Failed to fork template: ${error.message}`);
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
        <h1 className="text-2xl font-bold text-zinc-50">Template Marketplace</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Start with a proven demo pattern. Fork any template into your project.
        </p>
      </div>

      {/* Template grid */}
      <TemplateGrid onUseTemplate={handleUseTemplate} />

      {/* Fork result modal */}
      {forkResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">Template Forked</h2>
                <p className="mt-0.5 text-sm text-zinc-400">{forkResult.templateName}</p>
              </div>
              <button
                type="button"
                onClick={() => setForkResult(null)}
                className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                aria-label="Close dialog"
              >
                <svg
                  aria-hidden="true"
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Story source preview */}
            <pre className="mt-4 max-h-72 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-300">
              <code>{forkResult.storySource}</code>
            </pre>

            {/* Instructions */}
            <p className="mt-3 text-xs text-zinc-500">
              Open this file in your StoryCapture desktop app to start customizing.
            </p>

            {/* Actions */}
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={handleDownload}
                className="flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                Download .story file
              </button>
              <button
                type="button"
                onClick={handleCopyToClipboard}
                className="flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
                {copyFeedback ? "Copied!" : "Copy to clipboard"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
