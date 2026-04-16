/**
 * Web account types for desktop-to-web linking.
 *
 * Mirrors `WebAccountInfo` from `apps/desktop/src-tauri/src/commands/web_account.rs`.
 * Used by the Accounts settings panel and upload/sync features.
 */

export interface WebAccountInfo {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  connectedAt: string; // ISO 8601 date string
}
