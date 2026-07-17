import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@/generated/prisma/client";

type Role = "OWNER" | "EDITOR" | "VIEWER";

const ROLE_HIERARCHY: Record<Role, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

/**
 * Verify that the authenticated user is a member of the given workspace
 * and optionally holds at least `minRole`. Returns the membership record.
 *
 * Throws `TRPCError({ code: "FORBIDDEN" })` on missing or insufficient role.
 */
export async function requireWorkspaceMember(
  prisma: PrismaClient,
  userId: string,
  workspaceId: string,
  minRole?: Role,
) {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: { userId, workspaceId },
    },
  });

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this workspace.",
    });
  }

  if (
    minRole &&
    ROLE_HIERARCHY[membership.role as Role] < ROLE_HIERARCHY[minRole]
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You need ${minRole} or higher role for this action.`,
    });
  }

  return membership;
}
