import { protectedProcedure, router } from "../init";

/**
 * User router — authenticated user profile and workspace queries.
 */
export const userRouter = router({
  /**
   * Get current authenticated user profile.
   */
  me: protectedProcedure.query(({ ctx }) => {
    return {
      id: ctx.user.id,
      name: ctx.user.name,
      email: ctx.user.email,
      image: ctx.user.image,
    };
  }),

  /**
   * Get all workspaces the current user is a member of, with their role.
   */
  workspaces: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.prisma.workspaceMember.findMany({
      where: { userId: ctx.user.id },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            isPersonal: true,
            createdAt: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });

    return memberships.map((m) => ({
      ...m.workspace,
      role: m.role,
    }));
  }),
});
