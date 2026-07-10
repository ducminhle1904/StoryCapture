export interface KeywordDoc {
  description: string;
  example: string;
}

export const VERB_DOCS: Record<string, KeywordDoc> = {
  navigate: {
    description: "Open a URL in the live browser.",
    example: 'navigate "https://app.example.com/login"',
  },
  click: {
    description: "Click an element by visible text or selector.",
    example: 'click "Sign In"',
  },
  type: {
    description: "Type text into an input.",
    example: 'type selector "#email" "user@example.com"',
  },
  scroll: {
    description: "Scroll the viewport in a direction (optional pixel amount).",
    example: "scroll down 300",
  },
  hover: {
    description: "Move the cursor over an element.",
    example: 'hover testid "menu"',
  },
  drag: {
    description: "Drag one element onto another.",
    example: 'drag aria "Card A" to aria "Slot B"',
  },
  select: {
    description: "Pick an option in a <select> control.",
    example: 'select selector "#country" "USA"',
  },
  upload: {
    description: 'Attach a local file to an <input type="file">.',
    example: 'upload selector "input[type=file]" "/tmp/photo.png"',
  },
  wait: {
    description: "Pause for a fixed duration (ms / s / m).",
    example: "wait 500ms",
  },
  "wait-for": {
    description: "Wait until an element appears (optional timeout).",
    example: 'wait-for "Loaded" timeout 5s',
  },
  assert: {
    description: "Fail the run if an element / text is not present.",
    example: 'assert "Welcome"',
  },
  screenshot: {
    description: "Capture a named PNG of the current viewport.",
    example: 'screenshot "after-login"',
  },
  pause: {
    description: "Stop the run; resume manually from the simulator.",
    example: "pause",
  },
  story: {
    description: "Top-level block declaring a story name.",
    example: 'story "Onboarding Flow" { … }',
  },
  scene: {
    description: "Scene block — groups a sequence of commands.",
    example: 'scene "Login" { … }',
  },
  meta: {
    description: "Meta block — declares app URL, viewport, theme, speed.",
    example: 'meta { app: "https://x" viewport: 1280x800 }',
  },
  app: {
    description: "Meta key: live preview URL for the simulator.",
    example: 'app: "https://app.example.com"',
  },
  viewport: {
    description: "Meta key: WIDTHxHEIGHT for the preview window.",
    example: "viewport: 1280x800",
  },
  theme: {
    description: "Meta key: light | dark | auto.",
    example: "theme: dark",
  },
  speed: {
    description: "Meta key: playback speed multiplier.",
    example: "speed: 1.0",
  },
  selector: {
    description: "Target prefix — CSS selector lookup.",
    example: 'click selector "#submit"',
  },
  testid: {
    description: "Target prefix — match data-testid attribute.",
    example: 'click testid "submit-button"',
  },
  aria: {
    description: "Target prefix — match accessible name / role.",
    example: 'click aria "Submit"',
  },
  nth: {
    description: "Pick the Nth match (1-indexed) when the locator is non-unique.",
    example: 'click testid "row" nth 2',
  },
};
