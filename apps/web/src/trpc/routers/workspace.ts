import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Context } from "../init";
import { protectedProcedure, router } from "../init";

/**
 * Workspace CRUD + RBAC middleware + invite procedures.
 *
 * 3-tier RBAC middleware:
 *   workspaceMemberProcedure: any member
 *   workspaceEditorProcedure: editor or owner
 *   workspaceOwnerProcedure: owner only
 *
 * Invite flow: random CUID token, 7-day expiry, single-use.
 */

// ─── Slug Utilities ───

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ─── Input requiring workspaceId (shared across RBAC middleware) ───

const workspaceIdInput = z.object({
  workspaceId: z.string(),
});

// ─── RBAC Middleware ───

/**
 * workspaceMemberProcedure: Validates user is a member of the workspace.
 * Adds `membership` (with role) to context.
 */
const workspaceMemberProcedure = protectedProcedure
  .input(workspaceIdInput)
  .use(async ({ ctx, input, next }) => {
    const membership = await ctx.prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: {
          userId: ctx.user.id,
          workspaceId: input.workspaceId,
        },
      },
    });

    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You are not a member of this workspace.",
      });
    }

    return next({
      ctx: {
        ...ctx,
        membership,
      } satisfies Context & { membership: typeof membership },
    });
  });

/**
 * workspaceEditorProcedure: member + role must be EDITOR or OWNER.
 */
const workspaceEditorProcedure = workspaceMemberProcedure.use(async ({ ctx, next }) => {
  if (ctx.membership.role === "VIEWER") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Editor or owner access required.",
    });
  }
  return next({ ctx });
});

/**
 * workspaceOwnerProcedure: member + role must be OWNER.
 */
const workspaceOwnerProcedure = workspaceMemberProcedure.use(async ({ ctx, next }) => {
  if (ctx.membership.role !== "OWNER") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Owner access required.",
    });
  }
  return next({ ctx });
});

// ─── Router ───

export const workspaceRouter = router({
  /**
   * Create a new workspace. Creator becomes OWNER.
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z
          .string()
          .min(3)
          .max(60)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Generate slug from name if not provided
      const baseSlug = input.slug ?? (slugify(input.name) || "workspace");
      let slug = baseSlug;
      let attempt = 0;

      // Ensure slug uniqueness
      while (true) {
        const existing = await ctx.prisma.workspace.findUnique({
          where: { slug },
          select: { id: true },
        });
        if (!existing) break;
        attempt++;
        slug = `${baseSlug}-${attempt}`;
      }

      const workspace = await ctx.prisma.workspace.create({
        data: {
          name: input.name,
          slug,
          isPersonal: false,
          members: {
            create: {
              userId: ctx.user.id,
              role: "OWNER",
            },
          },
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      });

      return workspace;
    }),

  /**
   * List all workspaces where user is a member, with role and counts.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.prisma.workspaceMember.findMany({
      where: { userId: ctx.user.id },
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

    return memberships.map((m) => ({
      workspaceId: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      isPersonal: m.workspace.isPersonal,
      role: m.role,
      videoCount: m.workspace._count.videos,
      memberCount: m.workspace._count.members,
    }));
  }),

  /**
   * Get workspace details (members only).
   */
  getById: workspaceMemberProcedure.query(async ({ ctx, input }) => {
    const workspace = await ctx.prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        isPersonal: true,
        createdAt: true,
        members: {
          select: {
            id: true,
            userId: true,
            role: true,
            joinedAt: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
          orderBy: { joinedAt: "asc" },
        },
        _count: { select: { videos: true } },
      },
    });

    if (!workspace) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace not found.",
      });
    }

    return {
      ...workspace,
      videoCount: workspace._count.videos,
      currentUserRole: ctx.membership.role,
    };
  }),

  /**
   * Update workspace name/slug (owner only).
   */
  update: workspaceOwnerProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100).optional(),
        slug: z
          .string()
          .min(3)
          .max(60)
          .regex(
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
            "Slug must be lowercase alphanumeric with hyphens only.",
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Validate slug uniqueness if changing
      if (input.slug) {
        const existing = await ctx.prisma.workspace.findFirst({
          where: { slug: input.slug, id: { not: input.workspaceId } },
          select: { id: true },
        });
        if (existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This slug is already taken.",
          });
        }
      }

      const updated = await ctx.prisma.workspace.update({
        where: { id: input.workspaceId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.slug ? { slug: input.slug } : {}),
        },
        select: { id: true, name: true, slug: true },
      });

      return updated;
    }),

  /**
   * Delete workspace (owner only). Personal workspace cannot be deleted.
   */
  delete: workspaceOwnerProcedure.mutation(async ({ ctx, input }) => {
    const workspace = await ctx.prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { id: true, isPersonal: true, _count: { select: { videos: true } } },
    });

    if (!workspace) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace not found.",
      });
    }

    if (workspace.isPersonal) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Personal workspace cannot be deleted.",
      });
    }

    // Cascade: members and invites are auto-deleted via onDelete: Cascade
    // Videos remain orphaned — warn user in UI (separate concern)
    await ctx.prisma.workspace.delete({ where: { id: input.workspaceId } });

    return { deleted: true };
  }),

  /**
   * Invite a member to workspace (editor+ can invite).
   * Editor can invite as editor/viewer; owner can invite with any role.
   * Token is a random CUID with 7-day expiry, single-use.
   */
  invite: workspaceEditorProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(["OWNER", "EDITOR", "VIEWER"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Editors cannot assign OWNER role
      if (ctx.membership.role === "EDITOR" && input.role === "OWNER") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Editors cannot invite with owner role.",
        });
      }

      // Check if user is already a member
      const existingUser = await ctx.prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });

      if (existingUser) {
        const existingMembership = await ctx.prisma.workspaceMember.findUnique({
          where: {
            userId_workspaceId: {
              userId: existingUser.id,
              workspaceId: input.workspaceId,
            },
          },
        });

        if (existingMembership) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "User is already a member of this workspace.",
          });
        }
      }

      // Create invite with 7-day expiry
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const invite = await ctx.prisma.workspaceInvite.create({
        data: {
          email: input.email,
          workspaceId: input.workspaceId,
          role: input.role,
          expiresAt,
        },
      });

      // Build invite link
      const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
      const inviteLink = `${baseUrl}/invite/${invite.token}`;

      // Attempt to send email via Resend (graceful degradation)
      let emailSent = false;
      try {
        const { sendInviteEmail } = await import("@/lib/email");
        const workspace = await ctx.prisma.workspace.findUnique({
          where: { id: input.workspaceId },
          select: { name: true },
        });
        const result = await sendInviteEmail(
          input.email,
          inviteLink,
          workspace?.name ?? "Unknown workspace",
          ctx.user.name ?? ctx.user.email ?? "A team member",
        );
        emailSent = result.sent;
      } catch {
        // Email sending is best-effort
        emailSent = false;
      }

      return {
        inviteId: invite.id,
        inviteLink,
        emailSent,
        expiresAt: invite.expiresAt,
      };
    }),

  /**
   * Accept an invite (consumes the token). Any authenticated user can accept.
   * Single-use token consumed on acceptance.
   */
  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.prisma.workspaceInvite.findUnique({
        where: { token: input.token },
        include: {
          workspace: { select: { id: true, name: true } },
        },
      });

      if (!invite) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invite not found or already used.",
        });
      }

      if (invite.expiresAt < new Date()) {
        // Clean up expired invite
        await ctx.prisma.workspaceInvite.delete({ where: { id: invite.id } });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This invite has expired.",
        });
      }

      // Check if already a member
      const existingMembership = await ctx.prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.user.id,
            workspaceId: invite.workspaceId,
          },
        },
      });

      if (existingMembership) {
        // Clean up the invite even if already a member
        await ctx.prisma.workspaceInvite.delete({ where: { id: invite.id } });
        throw new TRPCError({
          code: "CONFLICT",
          message: "You are already a member of this workspace.",
        });
      }

      // Add member and consume invite in a transaction
      const membership = await ctx.prisma.$transaction(async (tx) => {
        const member = await tx.workspaceMember.create({
          data: {
            userId: ctx.user.id,
            workspaceId: invite.workspaceId,
            role: invite.role,
          },
        });

        // Consume the invite (single-use)
        await tx.workspaceInvite.delete({ where: { id: invite.id } });

        return member;
      });

      return {
        workspaceId: invite.workspace.id,
        workspaceName: invite.workspace.name,
        role: membership.role,
      };
    }),

  /**
   * Remove a member from workspace (owner only).
   * Cannot remove self if sole owner.
   */
  removeMember: workspaceOwnerProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Cannot remove self if sole owner
      if (input.userId === ctx.user.id) {
        const ownerCount = await ctx.prisma.workspaceMember.count({
          where: {
            workspaceId: input.workspaceId,
            role: "OWNER",
          },
        });

        if (ownerCount <= 1) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot remove yourself as the sole owner. Transfer ownership first.",
          });
        }
      }

      const membership = await ctx.prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId: input.userId,
            workspaceId: input.workspaceId,
          },
        },
      });

      if (!membership) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Member not found in this workspace.",
        });
      }

      await ctx.prisma.workspaceMember.delete({
        where: { id: membership.id },
      });

      return { removed: true };
    }),

  /**
   * Update a member's role (owner only).
   */
  updateMemberRole: workspaceOwnerProcedure
    .input(
      z.object({
        userId: z.string(),
        role: z.enum(["OWNER", "EDITOR", "VIEWER"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId: input.userId,
            workspaceId: input.workspaceId,
          },
        },
      });

      if (!membership) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Member not found in this workspace.",
        });
      }

      const updated = await ctx.prisma.workspaceMember.update({
        where: { id: membership.id },
        data: { role: input.role },
        select: { userId: true, role: true },
      });

      return updated;
    }),

  /**
   * Leave a workspace (any member). Sole owner cannot leave.
   */
  leave: workspaceMemberProcedure.mutation(async ({ ctx, input }) => {
    if (ctx.membership.role === "OWNER") {
      const ownerCount = await ctx.prisma.workspaceMember.count({
        where: {
          workspaceId: input.workspaceId,
          role: "OWNER",
        },
      });

      if (ownerCount <= 1) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot leave as the sole owner. Transfer ownership to another member first.",
        });
      }
    }

    await ctx.prisma.workspaceMember.delete({
      where: { id: ctx.membership.id },
    });

    return { left: true };
  }),
});
