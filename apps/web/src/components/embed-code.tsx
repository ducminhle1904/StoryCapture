"use client";

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
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

  const preset = SIZE_PRESETS[sizeIndex]!;
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
      <h3 className="text-sm font-medium text-[var(--color-text-primary)]">Embed Code</h3>

      {/* Size selector */}
      <SegmentedControl
        label="Embed size"
        value={String(sizeIndex)}
        onChange={(value) => setSizeIndex(Number(value))}
      >
        {SIZE_PRESETS.map((preset, index) => (
          <SegmentedControlItem key={preset.label} value={String(index)} label={preset.label} />
        ))}
      </SegmentedControl>

      {/* Code snippet */}
      <div className="relative">
        <pre className="overflow-x-auto rounded-[var(--radius-element)] bg-[var(--color-syntax-background)] p-3 text-xs text-[var(--color-text-secondary)]">
          <code>{iframeCode}</code>
        </pre>
        <AstryxButton
          label={copied ? "Copied!" : "Copy embed code"}
          size="sm"
          variant="secondary"
          onClick={handleCopy}
          className="absolute right-2 top-2"
        >
          {copied ? "Copied!" : "Copy"}
        </AstryxButton>
      </div>

      {/* oEmbed reference */}
      <p className="text-xs text-[var(--color-text-secondary)]">
        oEmbed discovery:{" "}
        <code className="rounded-[var(--radius-inner)] bg-[var(--color-background-muted)] px-1 py-0.5 text-[var(--color-text-secondary)]">
          {baseUrl}/api/oembed?url={baseUrl}/watch/&lt;slug&gt;
        </code>
      </p>
    </div>
  );
}
