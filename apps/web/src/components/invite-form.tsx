"use client";

import { useState } from "react";
import { useTRPC } from "@/trpc/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Invite form for workspace members page.
 * Email input + role selector + copy invite link.
 * Per D-04: editors can invite as editor/viewer; owners can invite with any role.
 */
export function InviteForm({
  workspaceId,
  currentUserRole,
}: {
  workspaceId: string;
  currentUserRole: "OWNER" | "EDITOR" | "VIEWER";
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"OWNER" | "EDITOR" | "VIEWER">("VIEWER");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const inviteMutation = useMutation(
    trpc.workspace.invite.mutationOptions({
      onSuccess: (data) => {
        setInviteLink(data.inviteLink);
        setEmail("");
        queryClient.invalidateQueries({
          queryKey: trpc.workspace.getById.queryKey({ workspaceId }),
        });
      },
    }),
  );

  // Only editors and owners can invite
  if (currentUserRole === "VIEWER") return null;

  const roleOptions =
    currentUserRole === "OWNER"
      ? (["OWNER", "EDITOR", "VIEWER"] as const)
      : (["EDITOR", "VIEWER"] as const);

  async function handleCopy() {
    if (inviteLink) {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <h3 className="mb-3 text-sm font-semibold text-zinc-200">
        Invite Member
      </h3>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) {
            setInviteLink(null);
            inviteMutation.mutate({ workspaceId, email: email.trim(), role });
          }
        }}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <label
            htmlFor="invite-email"
            className="mb-1 block text-xs text-zinc-500"
          >
            Email address
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            required
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="invite-role"
            className="mb-1 block text-xs text-zinc-500"
          >
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) =>
              setRole(e.target.value as "OWNER" | "EDITOR" | "VIEWER")
            }
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none"
          >
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r.charAt(0) + r.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={inviteMutation.isPending || !email.trim()}
          className="rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300 disabled:opacity-50"
        >
          {inviteMutation.isPending ? "Sending..." : "Send Invite"}
        </button>
      </form>

      {inviteMutation.error && (
        <p className="mt-2 text-sm text-red-400">
          {inviteMutation.error.message}
        </p>
      )}

      {inviteLink && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2">
          <span className="flex-1 truncate text-xs text-zinc-400">
            {inviteLink}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 rounded-lg bg-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-600"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {inviteLink && inviteMutation.data && (
        <p className="mt-1 text-xs text-zinc-500">
          {inviteMutation.data.emailSent
            ? "Invite email sent successfully."
            : "Email not configured. Share the link above manually."}
        </p>
      )}
    </div>
  );
}
