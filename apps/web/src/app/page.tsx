import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

/**
 * Landing page for unauthenticated visitors.
 *
 * - Hero section with tagline
 * - 3 feature cards: Record, Polish, Share
 * - CTA button -> /sign-in
 * - Footer
 *
 * If user is already authenticated, redirect to /dashboard.
 */
export default async function HomePage() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950">
      {/* Nav */}
      <header className="border-b border-zinc-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="text-lg font-semibold text-zinc-50">
            StoryCapture
          </span>
          <Link
            href="/sign-in"
            className="rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300"
          >
            Sign In
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-24">
        <h1 className="max-w-2xl text-center text-4xl font-bold leading-tight tracking-tight text-zinc-50 sm:text-5xl">
          Turn stories into shareable demo videos
        </h1>
        <p className="mt-6 max-w-xl text-center text-lg text-zinc-400">
          Write a story in a simple DSL. StoryCapture automates the browser,
          records the screen, and applies cinematic polish -- no video editing
          skills required.
        </p>
        <Link
          href="/sign-in"
          className="mt-8 rounded-xl bg-zinc-100 px-8 py-3 text-base font-semibold text-zinc-900 transition-colors hover:bg-white"
        >
          Get Started
        </Link>

        {/* Feature cards */}
        <div className="mt-20 grid max-w-4xl gap-6 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
              <svg
                className="h-5 w-5 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </div>
            <h3 className="mt-4 text-base font-semibold text-zinc-100">
              Record
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Write your story as a script. StoryCapture drives the browser and
              captures every frame automatically.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
              <svg
                className="h-5 w-5 text-amber-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                />
              </svg>
            </div>
            <h3 className="mt-4 text-base font-semibold text-zinc-100">
              Polish
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Auto-zoom, cursor animations, transitions, and sound design
              transform raw recordings into cinematic demos.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800">
              <svg
                className="h-5 w-5 text-blue-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </svg>
            </div>
            <h3 className="mt-4 text-base font-semibold text-zinc-100">
              Share
            </h3>
            <p className="mt-2 text-sm text-zinc-400">
              Upload to the web, share with a link, embed anywhere. Track views
              and watch analytics in real time.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-6 sm:flex-row sm:justify-between">
          <p className="text-sm text-zinc-600">
            Made with StoryCapture
          </p>
          <div className="flex gap-6 text-sm text-zinc-500">
            <Link
              href="/sign-in"
              className="transition-colors hover:text-zinc-300"
            >
              Sign In
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
