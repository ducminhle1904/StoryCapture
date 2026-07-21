import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
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

  const sideNav = (
    <SideNav>
      <SideNavSection title="Workspace" isHeaderHidden>
        <SideNavItem label="Dashboard" href="/dashboard" />
        <SideNavItem label="Templates" href="/templates" />
        <SideNavItem label="Sync" href="/sync" />
      </SideNavSection>
    </SideNav>
  );

  const topNav = (
    <TopNav
      label="StoryCapture navigation"
      heading={<TopNavHeading heading="StoryCapture" headingHref="/dashboard" />}
      endContent={
        <div className="flex items-center gap-3">
          {user.image ? (
            <img
              src={user.image}
              alt={user.name ?? "User avatar"}
              className="h-8 w-8 rounded-full"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-background-muted)] text-xs font-medium text-[var(--color-text-primary)]">
              {user.name?.charAt(0)?.toUpperCase() ?? "?"}
            </div>
          )}
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-sm font-medium text-[var(--color-text-primary)]">
              {user.name ?? "User"}
            </p>
            <p className="truncate text-xs text-[var(--color-text-secondary)]">{user.email}</p>
          </div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/sign-in" });
            }}
          >
            <Button type="submit" label="Sign out" variant="ghost" size="sm" />
          </form>
        </div>
      }
    />
  );

  return (
    <AppShell
      variant="elevated"
      topNav={topNav}
      sideNav={sideNav}
      mobileNav={{ breakpoint: "md" }}
      contentPadding={0}
    >
      <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
    </AppShell>
  );
}
