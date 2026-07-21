"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useMutation } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * Invite acceptance page.
 * - Authenticated: shows "Accept Invite" button -> calls acceptInvite -> redirects to workspace.
 * - Not authenticated: shows "Sign in to accept" -> redirects to sign-in with callback.
 * - Expired token: shows error.
 */
export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const { data: session, status: sessionStatus } = useSession();
  const router = useRouter();
  const trpc = useTRPC();
  const [error, setError] = useState<string | null>(null);

  const acceptMutation = useMutation(
    trpc.workspace.acceptInvite.mutationOptions({
      onSuccess: (data) => {
        router.push(`/workspace/${data.workspaceId}`);
      },
      onError: (err) => {
        setError(err.message);
      },
    }),
  );

  const isLoading = sessionStatus === "loading";

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-background-body)]">
        <Spinner label="Loading invitation" />
      </div>
    );
  }

  // Not authenticated
  if (!session?.user) {
    const callbackUrl = encodeURIComponent(`/invite/${token}`);
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-background-body)]">
        <Card width="100%" maxWidth={384} padding={8} className="text-center">
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">
            Workspace Invitation
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
            Sign in to accept this invitation and join the workspace.
          </p>
          <Button
            href={`/sign-in?callbackUrl=${callbackUrl}`}
            label="Sign in to accept"
            variant="primary"
            className="mt-6"
          />
        </Card>
      </div>
    );
  }

  // Authenticated
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-background-body)]">
      <Card width="100%" maxWidth={384} padding={8} className="text-center">
        <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Workspace Invitation</h1>

        {error ? (
          <>
            <div className="mt-3 text-left">
              <Banner status="error" title="Unable to join workspace" description={error} />
            </div>
            <Button href="/" label="Go to dashboard" variant="secondary" className="mt-6" />
          </>
        ) : acceptMutation.isSuccess ? (
          <>
            <p className="mt-3 text-sm text-[var(--color-success)]">
              You have joined <strong>{acceptMutation.data.workspaceName}</strong> as{" "}
              {acceptMutation.data.role.toLowerCase()}.
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-secondary)]">Redirecting...</p>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              You have been invited to join a workspace. Click below to accept.
            </p>
            <Button
              onClick={() => acceptMutation.mutate({ token })}
              label="Accept invite"
              variant="primary"
              isLoading={acceptMutation.isPending}
              isDisabled={acceptMutation.isPending}
              className="mt-6"
            />
          </>
        )}
      </Card>
    </div>
  );
}
