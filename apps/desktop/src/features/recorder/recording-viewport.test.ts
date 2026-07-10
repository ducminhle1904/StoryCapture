import { describe, expect, it } from "vitest";

import {
  storyAppUrlForRecording,
  storyFirstNavigateUrlForRecording,
  storyInitialUrlForRecording,
  storyViewportSize,
} from "./recording-viewport";

describe("recording viewport helpers", () => {
  it("preserves numeric story viewport metadata", () => {
    const source = `
      story "Demo" {
        meta {
          app: "https://app.example.test"
          viewport: 1920x1080
        }
      }
    `;

    expect(storyViewportSize(source)).toEqual({ width: 1920, height: 1080 });
    expect(storyAppUrlForRecording(source)).toBe("https://app.example.test/");
  });

  it("reads meta.app through the story parser", () => {
    const source = `
      # app: "https://commented.example.test"
      story "Demo" {
        scene "Setup" {
          type field "App" "https://body.example.test"
        }
        meta {
          app: "https://app.example.test"
        }
      }
    `;

    expect(storyAppUrlForRecording(source)).toBe("https://app.example.test/");
  });

  it("uses existing named editor viewport presets", () => {
    expect(storyViewportSize("meta { viewport: tablet }")).toEqual({
      width: 768,
      height: 1024,
    });
  });

  it("starts recording from meta.app while preserving the first navigate URL", () => {
    const source = `
      story "Demo" {
        meta {
          app: "https://app.example.test/auth/login"
        }
        scene "Login" {
          navigate "https://app.example.test/auth/login?redirect=/app/bots"
          type field "Email" "debug"
        }
      }
    `;

    expect(storyFirstNavigateUrlForRecording(source)).toBe(
      "https://app.example.test/auth/login?redirect=/app/bots",
    );
    expect(storyInitialUrlForRecording(source)).toBe("https://app.example.test/auth/login");
  });

  it("uses meta.app when there is no valid browser navigate", () => {
    const source = `
      story "Demo" {
        meta {
          app: "https://app.example.test/auth/login"
        }
        scene "Login" {
          navigate "mailto:support@example.test"
          type field "Email" "debug"
        }
      }
    `;

    expect(storyFirstNavigateUrlForRecording(source)).toBeNull();
    expect(storyInitialUrlForRecording(source)).toBe("https://app.example.test/auth/login");
  });
});
