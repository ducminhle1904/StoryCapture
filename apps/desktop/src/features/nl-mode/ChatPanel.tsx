/**
 * NL Mode chat panel.
 *
 * Resizable right panel (min 320, max 560, default 420px); collapsible to 40px rail.
 */

import { Banner } from "@astryxdesign/core/Banner";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { TextArea as AstryxTextArea } from "@astryxdesign/core/TextArea";
import {
  History,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Settings,
} from "lucide-react";
import * as React from "react";
import { useCallback, useRef } from "react";
import { TokenCounter } from "@/features/status-bar/TokenCounter";
import { cn } from "@/lib/utils";
import { ChatBubble } from "./ChatBubble";
import { CostWarningModal } from "./CostWarningModal";
import { useNlStore } from "./nlStore";
import { RateLimitBanner } from "./RateLimitBanner";
import { useNlChat } from "./useNlChat";

export interface ChatPanelProps {
  projectId: string;
  currentStory: string;
  sessionId?: string;
  className?: string;
}

const COST_WARNING_THRESHOLD = 50_000;

export function ChatPanel({ projectId, currentStory, sessionId, className }: ChatPanelProps) {
  const { panelWidth, panelCollapsed, streaming, pendingCards, error, messages, togglePanel } =
    useNlStore();

  const { send } = useNlChat(projectId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const costWarningSuppressedRef = useRef(false);
  const pendingWarningRef = useRef<string | null>(null);
  const pendingWarningTokensRef = useRef(0);
  const [warningOpen, setWarningOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  const isEmpty = pendingCards.length === 0 && streaming === null && messages.length === 0;
  const inlineError =
    error?.kind === "auth"
      ? "API key không hợp lệ. Cập nhật trong Settings."
      : error?.kind === "network"
        ? "Không kết nối được. Kiểm tra mạng và thử lại."
        : null;

  const sendMessage = useCallback(
    async (message: string) => {
      setDraft("");
      await send(message, currentStory);
    },
    [currentStory, send],
  );

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;

    const estimatedTokens = Math.ceil((text.length + currentStory.length) / 4);
    if (estimatedTokens > COST_WARNING_THRESHOLD && !costWarningSuppressedRef.current) {
      pendingWarningRef.current = text;
      pendingWarningTokensRef.current = estimatedTokens;
      setWarningOpen(true);
      return;
    }

    await sendMessage(text);
  }, [currentStory.length, draft, sendMessage]);

  const handleWarningResult = useCallback(
    async ({ proceed, suppressForSession }: { proceed: boolean; suppressForSession: boolean }) => {
      setWarningOpen(false);
      if (suppressForSession) {
        costWarningSuppressedRef.current = true;
      }
      if (!proceed || !pendingWarningRef.current) {
        pendingWarningRef.current = null;
        pendingWarningTokensRef.current = 0;
        return;
      }

      const message = pendingWarningRef.current;
      pendingWarningRef.current = null;
      pendingWarningTokensRef.current = 0;
      await sendMessage(message);
    },
    [sendMessage],
  );

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
          "flex flex-col items-center gap-3 border-l border-[var(--color-border)] bg-[var(--color-background-card)] py-3",
          className,
        )}
        style={{ width: 40 }}
      >
        <AstryxButton
          variant="ghost"
          size="sm"
          onClick={togglePanel}
          label={"M\u1edf r\u1ed9ng panel"}
          isIconOnly
          icon={<PanelRightOpen className="h-4 w-4" />}
        />
        <AstryxButton
          variant="ghost"
          size="sm"
          label="Chat"
          isIconOnly
          icon={<MessageCircle className="h-4 w-4" />}
        />
        <AstryxButton
          variant="ghost"
          size="sm"
          label={"L\u1ecbch s\u1eed"}
          isIconOnly
          icon={<History className="h-4 w-4" />}
        />
        <AstryxButton
          variant="ghost"
          size="sm"
          label={"C\u00e0i \u0111\u1eb7t"}
          isIconOnly
          icon={<Settings className="h-4 w-4" />}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="nl-chat-panel"
      className={cn(
        "flex flex-col border-l border-[var(--color-border)] bg-[var(--color-background-card)]",
        className,
      )}
      style={{ width: panelWidth, minWidth: 320, maxWidth: 560 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border,#242733)] px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-text-secondary,#8A90A2)]">
            NL assistant
          </div>
          <h2 className="mt-1 text-sm font-semibold text-[var(--color-text-primary,#E6E8EE)]">
            Rewrite the story in plain language
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {sessionId ? <TokenCounter projectId={projectId} sessionId={sessionId} /> : null}
          <AstryxButton
            variant="ghost"
            size="sm"
            onClick={togglePanel}
            label={"Thu g\u1ecdn panel"}
            isIconOnly
            icon={<PanelRightClose className="h-4 w-4" />}
          />
        </div>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5">
        {/* Error banners */}
        {error?.kind === "rate_limit" && (
          <RateLimitBanner message={error.message} retryAfterS={error.retryAfterS} />
        )}
        {inlineError ? <Banner status="error" title={inlineError} className="mb-3" /> : null}

        {/* Empty state */}
        {isEmpty && !error && (
          <div className="rounded-[var(--radius-page)] border border-[var(--color-border)] bg-[var(--color-background-muted)] p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[var(--color-text-secondary,#8A90A2)]">
              <MessageCircle className="h-4 w-4" />
              Suggested prompts
            </div>
            <h3 className="mt-3 text-lg font-semibold text-[var(--color-text-primary,#E6E8EE)]">
              {"Vi\u1ebft story b\u1eb1ng l\u1eddi"}
            </h3>
            <p className="font-serif mt-2 max-w-xs text-sm leading-6 text-[var(--color-text-secondary,#8A90A2)]">
              {
                "M\u00f4 t\u1ea3 lu\u1ed3ng b\u1ea1n mu\u1ed1n demo \u2014 v\u00ed d\u1ee5 \u201c\u0110\u0103ng nh\u1eadp v\u00e0o app, t\u1ea1o project m\u1edbi, share link\u201d. StoryCapture s\u1ebd sinh t\u1eebng b\u01b0\u1edbc DSL \u0111\u1ec3 b\u1ea1n duy\u1ec7t."
              }
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <AstryxButton
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft(
                    "Create a short onboarding demo: open the app, create a project, and share the result.",
                  );
                }}
                label="Make the onboarding story shorter"
                className="w-full justify-start"
              >
                Make the onboarding story shorter
              </AstryxButton>
              <AstryxButton
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft("Rewrite the current story with clearer narration for each step.");
                }}
                label="Rewrite the narration in a cleaner voice"
                className="w-full justify-start"
              >
                Rewrite the narration in a cleaner voice
              </AstryxButton>
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <div key={msg.id} className="mb-3">
            <ChatBubble author={msg.role} text={msg.text} />
          </div>
        ))}

        {/* Streaming bubble */}
        {streaming && (
          <div className="mb-3">
            <ChatBubble author="assistant" text={streaming.text} isStreaming />
            <div role="status" aria-live="polite" className="sr-only">
              {"\u0110ang sinh b\u01b0\u1edbc\u2026"}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-[var(--color-border)] p-4">
        <div className="flex gap-2">
          <AstryxTextArea
            ref={textareaRef}
            label="Message"
            isLabelHidden
            value={draft}
            onChange={setDraft}
            placeholder={"M\u00f4 t\u1ea3 lu\u1ed3ng b\u1ea1n mu\u1ed1n\u2026"}
            onKeyDown={handleKeyDown}
            className="flex-1"
            rows={2}
            width="100%"
          />
          <AstryxButton
            onClick={handleSend}
            className="self-end bg-[var(--color-accent,#7C3AED)] hover:bg-[var(--color-accent,#7C3AED)]/80"
            size="sm"
            isIconOnly
            aria-label={"G\u1eedi"}
            label="Gửi"
          >
            <Send className="h-4 w-4" />
          </AstryxButton>
        </div>
        <div className="mt-1 text-right text-xs text-[var(--color-text-secondary,#8A90A2)]">
          {"\u2318\u21b5 G\u1eedi"}
        </div>
      </div>
      <CostWarningModal
        estimatedTokens={pendingWarningTokensRef.current}
        open={warningOpen}
        suppressed={costWarningSuppressedRef.current}
        onResult={(result) => {
          void handleWarningResult(result);
        }}
      />
    </div>
  );
}
