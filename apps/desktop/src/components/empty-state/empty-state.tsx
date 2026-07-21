import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Kbd } from "@astryxdesign/core/Kbd";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import storyToVideoEmptySrc from "@/assets/illustrations/story-to-video-empty.png";

export interface StoryEmptyStateProps {
  title: string;
  description: string;
  actions?: ReactNode;
}

export function StoryEmptyState({ title, description, actions }: StoryEmptyStateProps) {
  return (
    <div className="grid min-h-[400px] place-items-center px-10 py-10">
      <div className="flex w-full flex-col items-center gap-4">
        <EmptyState
          title={title}
          description={description}
          actions={actions}
          headingLevel={2}
          icon={
            <img
              src={storyToVideoEmptySrc}
              alt=""
              aria-hidden="true"
              className="block size-[172px] object-cover"
              style={{
                borderRadius: "var(--radius-container)",
                border: "1px solid var(--color-border)",
                boxShadow: "var(--shadow-high)",
              }}
            />
          }
        />
        <Text type="supporting">
          Try <Kbd keys="⌘K" /> for commands.
        </Text>
      </div>
    </div>
  );
}
