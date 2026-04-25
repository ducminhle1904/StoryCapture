import type { MetadataRoute } from "next";

const siteUrl = "https://story-capture-web.vercel.app";
const lastModified = new Date("2026-04-25");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/templates`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${siteUrl}/sign-in`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
