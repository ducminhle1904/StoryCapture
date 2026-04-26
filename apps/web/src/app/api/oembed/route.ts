import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createPresignedGetUrl, R2_BUCKET } from "@/lib/r2";

/**
 * oEmbed endpoint for auto-unfurl in Notion, Slack, Discord.
 * GET /api/oembed?url=<watch-url>&format=json&maxwidth=N&maxheight=N
 *
 * Returns oEmbed "rich" type response with iframe HTML pointing to /embed/<id>.
 * Only returns data for public videos; private videos return 404 to prevent
 * information disclosure.
 *
 * @see https://oembed.com/
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const url = searchParams.get("url");
  const format = searchParams.get("format") ?? "json";

  // Only JSON format supported in v1
  if (format !== "json") {
    return NextResponse.json(
      { error: "Only JSON format is supported." },
      { status: 501 },
    );
  }

  if (!url) {
    return NextResponse.json(
      { error: "Missing required 'url' parameter." },
      { status: 400 },
    );
  }

  // Extract slug from URL pattern: .../watch/<slug>
  const slugMatch = url.match(/\/watch\/([a-z0-9-]+)\/?$/i);
  if (!slugMatch) {
    return NextResponse.json(
      { error: "URL does not match /watch/<slug> pattern." },
      { status: 404 },
    );
  }

  const slug = slugMatch[1]!;

  const video = await prisma.video.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      projectName: true,
      status: true,
      isPublic: true,
      thumbnailR2Key: true,
    },
  });

  // Only return oEmbed for public, ready videos
  if (!video || video.status !== "READY" || !video.isPublic) {
    return NextResponse.json(
      { error: "Video not found." },
      { status: 404 },
    );
  }

  // Parse maxwidth/maxheight with 16:9 defaults
  const maxwidth = Math.min(
    parseInt(searchParams.get("maxwidth") ?? "1280", 10) || 1280,
    1920,
  );
  const maxheight = Math.min(
    parseInt(searchParams.get("maxheight") ?? "720", 10) || 720,
    1080,
  );

  // Maintain 16:9 aspect ratio within constraints
  let width = maxwidth;
  let height = Math.round(width * (9 / 16));
  if (height > maxheight) {
    height = maxheight;
    width = Math.round(height * (16 / 9));
  }

  // Build embed URL
  const origin = request.nextUrl.origin;
  const embedUrl = `${origin}/embed/${video.id}`;

  // Thumbnail presigned URL
  const thumbnailUrl = video.thumbnailR2Key
    ? await createPresignedGetUrl(R2_BUCKET, video.thumbnailR2Key)
    : undefined;

  const oembedResponse = {
    version: "1.0",
    type: "rich" as const,
    title: video.projectName,
    provider_name: "StoryCapture",
    provider_url: origin,
    width,
    height,
    html: `<iframe src="${embedUrl}" width="${width}" height="${height}" frameborder="0" allowfullscreen></iframe>`,
    ...(thumbnailUrl
      ? {
          thumbnail_url: thumbnailUrl,
          thumbnail_width: width,
          thumbnail_height: height,
        }
      : {}),
  };

  return NextResponse.json(oembedResponse, {
    headers: {
      "Content-Type": "application/json+oembed",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
