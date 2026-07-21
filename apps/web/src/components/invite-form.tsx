"use client";

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * Invite form for workspace members page.
 * Email input + role selector + copy invite link.
 * Editors can invite as editor/viewer; owners can invite with any role.
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
    <Card className="p-5">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Invite Member</h3>

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
          <TextInput
            label="Email address"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="colleague@example.com"
            isRequired
            width="100%"
          />
        </div>

        <div className="min-w-36">
          <Selector
            label="Role"
            value={role}
            onChange={(value) => setRole(value as "OWNER" | "EDITOR" | "VIEWER")}
            options={roleOptions.map((roleOption) => ({
              value: roleOption,
              label: roleOption.charAt(0) + roleOption.slice(1).toLowerCase(),
            }))}
          />
        </div>

        <AstryxButton
          type="submit"
          label={inviteMutation.isPending ? "Sending..." : "Send Invite"}
          variant="primary"
          isLoading={inviteMutation.isPending}
          isDisabled={inviteMutation.isPending || !email.trim()}
        >
          {inviteMutation.isPending ? "Sending..." : "Send Invite"}
        </AstryxButton>
      </form>

      {inviteMutation.error && (
        <p className="mt-2 text-sm text-[var(--color-error)]">{inviteMutation.error.message}</p>
      )}

      {inviteLink && (
        <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-muted)] px-3 py-2">
          <span className="flex-1 truncate text-xs text-[var(--color-text-secondary)]">
            {inviteLink}
          </span>
          <AstryxButton
            label={copied ? "Copied!" : "Copy"}
            size="sm"
            variant="secondary"
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy"}
          </AstryxButton>
        </div>
      )}

      {inviteLink && inviteMutation.data && (
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          {inviteMutation.data.emailSent
            ? "Invite email sent successfully."
            : "Email not configured. Share the link above manually."}
        </p>
      )}
    </Card>
  );
}
