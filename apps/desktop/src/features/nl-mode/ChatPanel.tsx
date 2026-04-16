/**
 * NL Mode chat panel.
 *
 * Resizable right panel (min 320, max 560, default 420px) per UI-SPEC Layout Contract.
 * Collapsible to 40px rail with icon stack.
 * Header: "NL Mode" (Heading/Emphasis).
 * Composer: Textarea + "Gui" (accent) button. Cmd+Enter shortcut.
 * States: empty, loading, streaming, success, rate-limited, auth-failed, network-error.
 */

import * as React from "react";
import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  MessageCircle,
  History,
  Settings,
  PanelRightClose,
  PanelRightOpen,
  Send,
} from "lucide-react";
import { useNlStore } from "./nlStore";
import { ChatBubble } from "./ChatBubble";
import { RateLimitBanner } from "./RateLimitBanner";
import { useNlChat } from "./useNlChat";

export interface ChatPanelProps {
  projectId: string;
  currentStory: string;
  className?: string;
}

export function ChatPanel({
  projectId,
  currentStory,
  className,
}: ChatPanelProps) {
  const {
    panelWidth,
    panelCollapsed,
    streaming,
    pendingCards,
    error,
    messages,
    togglePanel,
  } = useNlStore();

  const { send } = useNlChat(projectId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isEmpty =
    pendingCards.length === 0 && streaming === null && messages.length === 0;

  const handleSend = useCallback(async () => {
    const text = textareaRef.current?.value?.trim();
    if (!text) return;

    const msg = text;
    if (textareaRef.current) textareaRef.current.value = "";
    await send(msg, currentStory);
  }, [send, currentStory]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Collapsed rail
  if (panelCollapsed) {
    return (
      <div
        data-testid="nl-chat-panel"
        className={cn(
          "flex flex-col items-center gap-3 border-l border-[var(--color-border,#242733)] bg-[var(--color-background,#0A0B0F)] py-3",
          className,
        )}
        style={{ width: 40 }}
      >
        <button
          onClick={togglePanel}
          aria-label={"M\u1edf r\u1ed9ng panel"}
          className="p-1 text-[var(--color-muted-foreground,#8A90A2)] hover:text-[var(--color-foreground,#E6E8EE)]"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <button
          aria-label="Chat"
          className="p-1 text-[var(--color-muted-foreground,#8A90A2)] hover:text-[var(--color-foreground,#E6E8EE)]"
        >
          <MessageCircle className="h-4 w-4" />
        </button>
        <button
          aria-label={"L\u1ecbch s\u1eed"}
          className="p-1 text-[var(--color-muted-foreground,#8A90A2)] hover:text-[var(--color-foreground,#E6E8EE)]"
        >
          <History className="h-4 w-4" />
        </button>
        <button
          aria-label={"C\u00e0i \u0111\u1eb7t"}
          className="p-1 text-[var(--color-muted-foreground,#8A90A2)] hover:text-[var(--color-foreground,#E6E8EE)]"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="nl-chat-panel"
      className={cn(
        "flex flex-col border-l border-[var(--color-border,#242733)] bg-[var(--color-background,#0A0B0F)]",
        className,
      )}
      style={{ width: panelWidth, minWidth: 320, maxWidth: 560 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border,#242733)] px-4 py-3">
        <h2 className="text-xl font-semibold text-[var(--color-foreground,#E6E8EE)]">
          NL Mode
        </h2>
        <button
          onClick={togglePanel}
          aria-label={"Thu g\u1ecdn panel"}
          className="p-1 text-[var(--color-muted-foreground,#8A90A2)] hover:text-[var(--color-foreground,#E6E8EE)]"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {/* Error banners */}
        {error?.kind === "rate_limit" && (
          <RateLimitBanner
            message={error.message}
            retryAfterS={error.retryAfterS}
          />
        )}
        {error?.kind === "auth" && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-[var(--color-destructive,#E5484D)]/30 bg-[var(--color-destructive,#E5484D)]/10 p-3 text-sm"
          >
            <p>
              {"API key kh\u00f4ng h\u1ee3p l\u1ec7. C\u1eadp nh\u1eadt trong Settings."}
            </p>
          </div>
        )}
        {error?.kind === "network" && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-[var(--color-destructive,#E5484D)]/30 bg-[var(--color-destructive,#E5484D)]/10 p-3 text-sm"
          >
            <p>
              {"Kh\u00f4ng k\u1ebft n\u1ed1i \u0111\u01b0\u1ee3c. Ki\u1ec3m tra m\u1ea1ng v\u00e0 th\u1eed l\u1ea1i."}
            </p>
          </div>
        )}

        {/* Empty state */}
        {isEmpty && !error && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <MessageCircle className="mb-4 h-12 w-12 text-[var(--color-muted-foreground,#8A90A2)]" />
            <h3 className="mb-2 text-lg font-semibold text-[var(--color-foreground,#E6E8EE)]">
              {"Vi\u1ebft story b\u1eb1ng l\u1eddi"}
            </h3>
            <p className="mb-4 max-w-xs text-sm text-[var(--color-muted-foreground,#8A90A2)]">
              {"M\u00f4 t\u1ea3 lu\u1ed3ng b\u1ea1n mu\u1ed1n demo \u2014 v\u00ed d\u1ee5 \u201c\u0110\u0103ng nh\u1eadp v\u00e0o app, t\u1ea1o project m\u1edbi, share link\u201d. StoryCapture s\u1ebd sinh t\u1eebng b\u01b0\u1edbc DSL \u0111\u1ec3 b\u1ea1n duy\u1ec7t."}
            </p>
            <Button variant="outline" size="sm">
              {"Th\u1eed v\u00ed d\u1ee5 m\u1eabu"}
            </Button>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <div key={msg.id} className="mb-3">
            <ChatBubble role={msg.role} text={msg.text} />
          </div>
        ))}

        {/* Streaming bubble */}
        {streaming && (
          <div className="mb-3">
            <ChatBubble
              role="assistant"
              text={streaming.text}
              isStreaming
            />
            <div role="status" aria-live="polite" className="sr-only">
              {"\u0110ang sinh b\u01b0\u1edbc\u2026"}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-[var(--color-border,#242733)] p-4">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            placeholder={"M\u00f4 t\u1ea3 lu\u1ed3ng b\u1ea1n mu\u1ed1n\u2026"}
            onKeyDown={handleKeyDown}
            className="flex-1 resize-none rounded-md border border-[var(--color-border,#242733)] bg-[var(--color-card,#13151C)] px-3 py-2 text-sm text-[var(--color-foreground,#E6E8EE)] placeholder:text-[var(--color-muted-foreground,#8A90A2)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent,#7C3AED)]"
            rows={2}
          />
          <Button
            onClick={handleSend}
            className="self-end bg-[var(--color-accent,#7C3AED)] hover:bg-[var(--color-accent,#7C3AED)]/80"
            size="icon"
            aria-label={"G\u1eedi"}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-1 text-right text-xs text-[var(--color-muted-foreground,#8A90A2)]">
          {"\u2318\u21b5 G\u1eedi"}
        </div>
      </div>
    </div>
  );
}
