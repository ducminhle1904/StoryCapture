import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

/**
 * NextAuth v5 configuration.
 *
 * - Providers: GitHub + Google OAuth (env vars auto-inferred: AUTH_GITHUB_ID/SECRET, AUTH_GOOGLE_ID/SECRET)
 * - Adapter: Prisma (User, Account, Session, VerificationToken models)
 * - Session strategy: database (revocable sessions per D-07)
 * - Auto-creates a personal workspace on first sign-in
 *
 * @see https://authjs.dev/getting-started/migrating-to-v5
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma) as ReturnType<typeof PrismaAdapter>,
  providers: [
    GitHub,
    Google,
  ],
  session: {
    strategy: "database",
  },
  callbacks: {
    session({ session, user }) {
      // Expose user.id on the session object for downstream use
      session.user.id = user.id;
      return session;
    },
  },
  events: {
    createUser: async ({ user }) => {
      // Auto-create a personal workspace for every new user (D-04)
      await prisma.workspace.create({
        data: {
          name: "Personal",
          slug: `personal-${user.id}`,
          isPersonal: true,
          members: {
            create: {
              userId: user.id!,
              role: "OWNER",
            },
          },
        },
      });
    },
  },
  pages: {
    signIn: "/sign-in",
  },
});
