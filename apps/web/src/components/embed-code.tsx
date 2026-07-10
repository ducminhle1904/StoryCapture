"use client";

import { useCallback, useState } from "react";

interface EmbedCodeProps {
  videoId: string;
  /** Base URL for the app, e.g. "https://storycapture.app" */
  baseUrl: string;
}

const SIZE_PRESETS = [
  { label: "Small (640x360)", width: 640, height: 360 },
  { label: "Medium (960x540)", width: 960, height: 540 },
  { label: "Large (1280x720)", width: 1280, height: 720 },
] as const;

/**
 * Embed code section showing a copyable iframe snippet.
 * Includes size preset selector and oEmbed discovery URL reference.
 */
export function EmbedCode({ videoId, baseUrl }: EmbedCodeProps) {
  const [sizeIndex, setSizeIndex] = useState(1); // Default to medium
  const [copied, setCopied] = useState(false);

  const preset = SIZE_PRESETS[sizeIndex] ?? SIZE_PRESETS[1];
  const embedUrl = `${baseUrl}/embed/${videoId}`;
  const iframeCode = `<iframe src="${embedUrl}" width="${preset.width}" height="${preset.height}" frameborder="0" allowfullscreen></iframe>`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(iframeCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = iframeCode;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [iframeCode]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-zinc-200">Embed Code</h3>

      {/* Size selector */}
      <div className="flex gap-2">
        {SIZE_PRESETS.map((p, i) => (
          <button
            type="button"
            key={p.label}
            onClick={() => setSizeIndex(i)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              i === sizeIndex
                ? "bg-zinc-100 text-zinc-900"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Code snippet */}
      <div className="relative">
        <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-zinc-300">
          <code>{iframeCode}</code>
        </pre>
        <button
          type="button"
          onClick={handleCopy}
          className="absolute right-2 top-2 rounded-md bg-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-600"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>

      {/* oEmbed reference */}
      <p className="text-xs text-zinc-500">
        oEmbed discovery:{" "}
        <code className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-400">
          {baseUrl}/api/oembed?url={baseUrl}/watch/&lt;slug&gt;
        </code>
      </p>
    </div>
  );
}
