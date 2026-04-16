import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

/**
 * Dashboard home page.
 * Shows a welcome message and the user's workspaces.
 * Server component — fetches data directly via Prisma.
 */
export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/sign-in");
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.user.id },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          isPersonal: true,
          _count: { select: { videos: true, members: true } },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-50">
          Welcome, {session.user.name ?? "there"}
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Manage your workspaces and recordings
        </p>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold text-zinc-200">
          Your Workspaces
        </h2>

        {memberships.length === 0 ? (
          <p className="text-sm text-zinc-500">No workspaces found.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {memberships.map((m) => (
              <div
                key={m.workspace.id}
                className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-colors hover:border-zinc-700"
              >
                <div className="flex items-start justify-between">
                  <h3 className="font-medium text-zinc-100">
                    {m.workspace.name}
                  </h3>
                  {m.workspace.isPersonal && (
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                      Personal
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {m.role.charAt(0) + m.role.slice(1).toLowerCase()}
                </p>
                <div className="mt-3 flex gap-4 text-xs text-zinc-500">
                  <span>{m.workspace._count.videos} videos</span>
                  <span>{m.workspace._count.members} members</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
