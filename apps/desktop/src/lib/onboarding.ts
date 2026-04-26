export const ONBOARDING_COMPLETED_KEY = "storycapture:onboarding:v1:completed";

export function hasCompletedOnboarding(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "true";
}

export function markOnboardingComplete(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ONBOARDING_COMPLETED_KEY, "true");
}
