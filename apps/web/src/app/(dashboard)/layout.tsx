import Image from "next/image";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";

/**
 * Auth-gated dashboard layout.
 * Server component that checks session and redirects unauthenticated users to /sign-in.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session?.user) {
    redirect("/sign-in");
  }

  const user = session.user;

  return (
    <div className="flex min-h-screen bg-zinc-950">
      {/* Sidebar */}
      <aside className="flex w-64 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="flex h-14 items-center border-b border-zinc-800 px-4">
          <span className="text-lg font-semibold text-zinc-50">StoryCapture</span>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          <a
            href="/dashboard"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-50"
          >
            Dashboard
          </a>
          <a
            href="/templates"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-50"
          >
            Templates
          </a>
          <a
            href="/sync"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-50"
          >
            Sync
          </a>
        </nav>

        {/* User section */}
        <div className="border-t border-zinc-800 p-3">
          <div className="flex items-center gap-3 rounded-lg px-3 py-2">
            {user.image ? (
              <Image
                src={user.image}
                alt={user.name ?? "User avatar"}
                width={32}
                height={32}
                unoptimized
                className="h-8 w-8 rounded-full"
              />
            ) : (
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-xs font-medium text-zinc-300">
                {user.name?.charAt(0)?.toUpperCase() ?? "?"}
              </div>
            )}
            <div className="flex-1 truncate">
              <p className="truncate text-sm font-medium text-zinc-200">{user.name ?? "User"}</p>
              <p className="truncate text-xs text-zinc-500">{user.email}</p>
            </div>
          </div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/sign-in" });
            }}
          >
            <button
              type="submit"
              className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
