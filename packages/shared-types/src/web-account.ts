/**
 * Web account types for desktop-to-web linking.
 *
 * Used by the Accounts settings panel and upload/sync features.
 */

export interface WebAccountInfo {
  email: string;
  name: string | null;
  avatarUrl: string | null;
  connectedAt: string; // ISO 8601 date string
}
