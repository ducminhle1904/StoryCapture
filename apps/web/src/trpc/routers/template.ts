import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { TemplateCategory, WorkflowType } from "@/generated/prisma";
import { slugify } from "@/lib/slugify";
import { protectedProcedure, publicProcedure, router } from "../init";

/**
 * Template marketplace router.
 *
 * - listByCategory: Public. Browse templates grouped by category.
 * - getById: Public. View template details with storySource preview.
 * - fork: Protected. Deep-copy storySource as downloadable .story file;
 *   forkCount incremented atomically via Prisma. storySource is intentionally
 *   public (curated system templates).
 */

const templateCategoryEnum = z.nativeEnum(TemplateCategory);
const workflowTypeEnum = z.nativeEnum(WorkflowType);

export const templateRouter = router({
  /**
   * List templates, optionally filtered by category.
   * When no category filter, returns all templates grouped by category.
   * Ordered by forkCount desc within each category.
   */
  listByCategory: publicProcedure
    .input(
      z
        .object({
          category: templateCategoryEnum.optional(),
          workflowType: workflowTypeEnum.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const where = {
        ...(input?.category ? { category: input.category } : {}),
        ...(input?.workflowType ? { workflowType: input.workflowType } : {}),
      };

      const templates = await ctx.prisma.template.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          category: true,
          workflowType: true,
          bestFor: true,
          durationTarget: true,
          polishPreset: true,
          requiredInputs: true,
          forkCount: true,
          thumbnailUrl: true,
        },
        orderBy: [{ category: "asc" }, { forkCount: "desc" }],
      });

      // Group by category
      const grouped: Record<string, typeof templates> = {};

      for (const template of templates) {
        const cat = template.category;
        const categoryTemplates = grouped[cat] ?? [];
        categoryTemplates.push(template);
        grouped[cat] = categoryTemplates;
      }

      return { templates, grouped };
    }),

  /**
   * Get full template details including storySource preview (first 500 chars).
   */
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const template = await ctx.prisma.template.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        workflowType: true,
        storySource: true,
        workflowState: true,
        bestFor: true,
        durationTarget: true,
        polishPreset: true,
        requiredInputs: true,
        forkCount: true,
        thumbnailUrl: true,
        createdAt: true,
      },
    });

    if (!template) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Template not found.",
      });
    }

    return {
      ...template,
      storySourcePreview: template.storySource.slice(0, 500),
    };
  }),

  /**
   * Fork a template — deep copy storySource as downloadable .story content.
   * Fork is a deep copy with no upstream sync and no attribution requirement;
   * forkCount is incremented atomically.
   */
  fork: protectedProcedure
    .input(
      z.object({
        templateId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const template = await ctx.prisma.template.findUnique({
        where: { id: input.templateId },
        select: {
          id: true,
          name: true,
          storySource: true,
          workflowType: true,
          workflowState: true,
          requiredInputs: true,
          polishPreset: true,
        },
      });

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found.",
        });
      }

      // Atomic increment of forkCount
      await ctx.prisma.template.update({
        where: { id: template.id },
        data: { forkCount: { increment: 1 } },
      });

      const fileName = `${slugify(template.name)}.story`;

      return {
        storySource: template.storySource,
        fileName,
        templateName: template.name,
        workflowType: template.workflowType,
        workflowState: template.workflowState,
        requiredInputs: template.requiredInputs,
        polishPreset: template.polishPreset,
      };
    }),
});
