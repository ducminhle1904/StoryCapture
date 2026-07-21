import { describe, expect, it } from "vitest";

import { buildOnboardingProjectDraft } from "./project-draft";

describe("buildOnboardingProjectDraft", () => {
  it("maps the selected workflow and a trimmed target URL", () => {
    expect(buildOnboardingProjectDraft("tutorial", "  https://acme.test/setup  ", false)).toEqual({
      workflowType: "tutorial",
      workflowInputs: { target_url: "https://acme.test/setup" },
    });
  });

  it("uses the starter target when sample mode is selected", () => {
    expect(buildOnboardingProjectDraft("support", "", true)).toEqual({
      workflowType: "support",
      workflowInputs: { target_url: "https://example.com" },
    });
  });
});
