"use client";

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
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  // Not authenticated
  if (!session?.user) {
    const callbackUrl = encodeURIComponent(`/invite/${token}`);
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
          <h1 className="text-xl font-bold text-zinc-50">Workspace Invitation</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Sign in to accept this invitation and join the workspace.
          </p>
          <a
            href={`/sign-in?callbackUrl=${callbackUrl}`}
            className="mt-6 inline-block rounded-lg bg-zinc-200 px-6 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300"
          >
            Sign in to accept
          </a>
        </div>
      </div>
    );
  }

  // Authenticated
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
        <h1 className="text-xl font-bold text-zinc-50">Workspace Invitation</h1>

        {error ? (
          <>
            <p className="mt-3 text-sm text-red-400">{error}</p>
            <a
              href="/"
              className="mt-6 inline-block rounded-lg border border-zinc-700 px-6 py-2.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Go to Dashboard
            </a>
          </>
        ) : acceptMutation.isSuccess ? (
          <>
            <p className="mt-3 text-sm text-green-400">
              You have joined <strong>{acceptMutation.data.workspaceName}</strong> as{" "}
              {acceptMutation.data.role.toLowerCase()}.
            </p>
            <p className="mt-1 text-xs text-zinc-500">Redirecting...</p>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-zinc-400">
              You have been invited to join a workspace. Click below to accept.
            </p>
            <button
              type="button"
              onClick={() => acceptMutation.mutate({ token })}
              disabled={acceptMutation.isPending}
              className="mt-6 rounded-lg bg-zinc-200 px-6 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300 disabled:opacity-50"
            >
              {acceptMutation.isPending ? "Joining..." : "Accept Invite"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
