/**
 * Analytics constants (Plan 04-08, D-06).
 */

/** Valid analytics event types for video view tracking. */
export const ANALYTICS_EVENTS = [
  "play",
  "pause",
  "seek",
  "scene_enter",
  "ended",
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENTS)[number];

/** Default dashboard time range in days (D-06). */
export const DASHBOARD_DAYS = 30;

/** Raw event retention in days before cleanup (D-06). */
export const MAX_RETENTION_DAYS = 90;

/** Session cookie name for anonymous viewer tracking (GDPR-safe per D-06). */
export const SESSION_COOKIE_NAME = "sc_session";

/** Session cookie max-age in seconds (30 days). */
export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
