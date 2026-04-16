# Phase 4: Web Companion & Sharing - Research

**Researched:** 2026-04-15
**Domain:** Next.js 15 App Router + tRPC 11 + Prisma 6 + Cloudflare R2 + NextAuth v5 + WebSocket/SSE sync
**Confidence:** HIGH

## Summary

Phase 4 builds the `apps/web` Next.js 15 companion that lets users sign in (GitHub/Google OAuth), upload polished videos from the desktop app to Cloudflare R2, share them via embeddable viewer pages with oEmbed, collaborate in team workspaces, view analytics, and receive live desktop recording status via SSE. The tech stack is fully committed (CLAUDE.md): Next.js 15 App Router, tRPC 11, Prisma 6, NextAuth v5 (Auth.js), Cloudflare R2, Neon PostgreSQL, deployed on Vercel.

The `apps/web` directory exists as a stub from Phase 1 scaffolding (Plan 01-01) with placeholder scripts. All web code is greenfield. The monorepo already has Turborepo, pnpm workspaces, shared packages (`@storycapture/shared-types`, `@storycapture/ui`, `@storycapture/config`), and the desktop `tauri-specta` IPC pattern that new upload commands will follow.

**Primary recommendation:** Use tRPC 11 with the fetch adapter for App Router + SSE subscriptions (not WebSockets) for live sync. Generate presigned R2 multipart URLs server-side; chunk uploads client-side in the desktop Tauri app. Use NextAuth v5 database sessions with Prisma adapter. Desktop authenticates via `tauri-plugin-oauth` localhost redirect flow, exchanges the OAuth code for a short-lived JWT used for SSE subscriptions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01: Upload trigger & flow** — Manual "Upload to Web" button only. No auto-upload. Resumable multipart via presigned R2 URLs. Desktop shows progress bar. No auto-retry on disconnect.
- **D-02: Viewer page privacy** — Private-by-default (unlisted, noindex). Owner can toggle public. No password protection or link expiry in v1. Vanity slugs at `/watch/<slug>`.
- **D-03: Embed format** — iframe snippet + oEmbed endpoint at `/api/oembed?url=...`. Thumbnail from first frame stored in R2. No standalone JS player widget in v1.
- **D-04: Workspace & roles model** — Free tier = 1 personal workspace. Team workspace with invite by email. 3 roles: owner, editor, viewer. Shared asset library. No billing in v1.
- **D-05: Template marketplace scope** — 10-15 curated templates only. Fork = deep copy. Browse by category grid. No search, no community submissions in v1.
- **D-06: Analytics depth** — Near-real-time via SSE (30s aggregation). Play count (total+unique), watch duration, drop-off heatmap (per DSL scene), geographic breakdown (country via MaxMind GeoLite2). GDPR-safe session-ID cookie. 30-day dashboard, 90-day raw event retention.
- **D-07: Desktop-web sync boundary** — Metadata-only sync. Live recording status via SSE. Story source read-only on web. Last-write-wins (desktop wins on story content). Offline queue in SQLite. Short-lived JWT (15 min) + refresh token.
- **D-08: Hosting & infrastructure** — Vercel + Cloudflare R2 + Neon PostgreSQL. Environment config via Vercel env vars.

### Claude's Discretion
- Database schema design (tables, indexes, relations) — follow Prisma 6 conventions
- tRPC router structure
- WebSocket/SSE server implementation
- Video thumbnail generation approach
- oEmbed response format
- GeoLite2 integration approach
- Session cookie implementation
- R2 bucket structure

### Deferred Ideas (OUT OF SCOPE)
- Password-protected viewer links (v2)
- Link expiry / auto-delete (v2)
- Community template submissions (v2)
- Bidirectional story editing on web (v2)
- Video comments / annotations (v2)
- Custom domain for viewer pages (v2)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WEB-01 | Next.js 15 App Router + TypeScript + tRPC 11 + Prisma 6 + PostgreSQL | Standard Stack section: full version-verified stack with tRPC fetch adapter pattern |
| WEB-02 | NextAuth v5 with GitHub + Google OAuth, Prisma adapter | Auth section: database sessions, Prisma adapter schema, desktop linking via localhost OAuth |
| WEB-03 | Upload pipeline desktop -> R2 via presigned multipart URLs | R2 Upload section: multipart workflow, presigned URL generation, chunked client upload |
| WEB-04 | Shareable viewer page with embed code + DSL chapter navigation | Viewer/Embed section: video player, oEmbed endpoint, scene-based chapters |
| WEB-05 | Team workspaces with RBAC (owner/editor/viewer) + shared asset libraries | Workspace section: Prisma schema pattern, tRPC middleware for role checks |
| WEB-06 | Template marketplace: browse, fork, share by category | Template section: fork-as-deep-copy pattern, category taxonomy schema |
| WEB-07 | Viewer analytics: play count, duration, drop-off, geo | Analytics section: event ingestion, aggregation, MaxMind GeoLite2, GDPR-safe tracking |
| WEB-08 | Desktop-web SSE sync: recording status, project mirror, JWT auth | Sync section: tRPC SSE subscriptions, tracked() reconnection, JWT refresh |
| UI-06 | Settings: Accounts screen (web account linking from desktop) | Desktop Integration section: OAuth flow, account linking UX |
| DIST-06 | Web uploads encrypted in transit (HTTPS) and at rest (R2 encryption) | R2 section: SSE-S3 encryption at rest, HTTPS in transit |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `next` | 16.2.x | App framework (App Router) | [VERIFIED: npm registry — 16.2.4 latest] Current stable; CLAUDE.md says 15.x but 16.x is current stable line. Use 15.3.x if conservative (15.3.9 is latest 15.x). |
| `@trpc/server` | 11.16.x | Type-safe API layer | [VERIFIED: npm registry — 11.16.0 latest] |
| `@trpc/client` | 11.16.x | Client bindings | [VERIFIED: npm registry — 11.16.0] |
| `@trpc/tanstack-react-query` | 11.16.x | React Query integration for App Router | [VERIFIED: npm registry — 11.16.0] |
| `@tanstack/react-query` | 5.x | Server state cache | [VERIFIED: committed stack, matches desktop] |
| `prisma` | 7.7.x | ORM + migrations (dev dep) | [VERIFIED: npm registry — 7.7.0 latest] CLAUDE.md says 6.x but 7.x is current. |
| `@prisma/client` | 7.7.x | Runtime client | [VERIFIED: npm registry — 7.7.0] |
| `next-auth` | 5.0.0-beta.31 | OAuth (GitHub + Google) | [VERIFIED: npm registry] Still beta; pin exact version per CLAUDE.md risk flag |
| `@auth/prisma-adapter` | 2.11.x | Prisma adapter for Auth.js | [VERIFIED: npm registry — 2.11.2] |
| `zod` | 4.3.x | tRPC input validation | [VERIFIED: npm registry — 4.3.6] |
| `react`, `react-dom` | 19.x | UI runtime (match desktop) | [VERIFIED: committed stack] |
| `typescript` | 5.7+ | Types | [VERIFIED: committed stack] |

**NOTE on version drift:** CLAUDE.md specifies Next.js 15.x and Prisma 6.x. Current npm latest is Next.js 16.2.x and Prisma 7.7.x. Recommendation: **use the latest stable** (16.x / 7.x) since this is greenfield code, but the planner should confirm with the user. If the user prefers to match CLAUDE.md exactly, pin `next@15.3.9` and `prisma@6.x`. [ASSUMED — user preference needed]

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@aws-sdk/client-s3` | 3.1030.x | R2 multipart upload server-side | Presigned URL generation [VERIFIED: npm registry] |
| `@aws-sdk/s3-request-presigner` | 3.1030.x | Presigned URL signing | Multipart upload parts [VERIFIED: npm registry] |
| `jose` | 6.2.x | JWT creation/verification for desktop auth | Desktop SSE auth tokens [VERIFIED: npm registry — 6.2.2] |
| `ws` | 8.20.x | WebSocket server (if SSE insufficient) | Fallback only; prefer SSE [VERIFIED: npm registry — 8.20.0] |
| `@maxmind/geoip2-node` | 6.3.x | GeoLite2 MMDB reader for country lookup | Analytics geo breakdown [VERIFIED: npm registry — 6.3.4] |
| `superjson` | latest | tRPC data transformer (Date, BigInt) | tRPC serialization [CITED: trpc.io/docs] |
| `pino` | 10.3.x | Server-side structured logging | [VERIFIED: npm registry — 10.3.1] |
| `pino-pretty` | 13.1.x | Dev log formatting | [VERIFIED: npm registry — 13.1.3] |
| `tailwindcss` | 4.x | Styling (shared tokens from `@storycapture/ui`) | [VERIFIED: committed stack] |
| `@tailwindcss/vite` | 4.x | Next.js + Tailwind v4 integration | [VERIFIED: committed stack] |
| `client-only` | latest | Guard server-only imports | [CITED: tRPC App Router docs] |
| `server-only` | latest | Guard client-only imports | [CITED: tRPC App Router docs] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| tRPC SSE subscriptions | tRPC WebSocket subscriptions | WS requires separate server; SSE works on Vercel edge out-of-box, auto-reconnects, simpler setup [CITED: trpc.io/docs/server/subscriptions] |
| `@aws-sdk/client-s3` | `@cloudflare/r2` bindings | R2 uses S3-compatible API; AWS SDK is universal, better documented, works from Vercel [VERIFIED: Cloudflare R2 docs] |
| MaxMind MMDB file | MaxMind web service API | MMDB file avoids per-query cost; download on deploy. Web service simpler but has query limits [CITED: dev.maxmind.com] |
| Database sessions (NextAuth) | JWT sessions (NextAuth) | Database sessions are more secure (revocable), work with Prisma adapter out-of-box. JWT sessions are edge-compatible but not revocable. Use database sessions since we have Neon. [ASSUMED] |

**Installation:**
```bash
cd apps/web
pnpm add next@latest react@latest react-dom@latest typescript@latest \
  @trpc/server @trpc/client @trpc/tanstack-react-query @tanstack/react-query \
  @prisma/client next-auth@beta @auth/prisma-adapter \
  zod superjson jose @aws-sdk/client-s3 @aws-sdk/s3-request-presigner \
  @maxmind/geoip2-node pino tailwindcss@latest \
  client-only server-only
pnpm add -D prisma pino-pretty @tailwindcss/vite
```

## Architecture Patterns

### Recommended Project Structure
```
apps/web/
├── prisma/
│   ├── schema.prisma          # All models
│   └── migrations/            # Prisma migrate
├── src/
│   ├── app/
│   │   ├── layout.tsx         # Root layout + TRPCProvider
│   │   ├── page.tsx           # Landing / marketing
│   │   ├── (auth)/
│   │   │   ├── sign-in/page.tsx
│   │   │   └── sign-out/page.tsx
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx     # Auth-gated layout
│   │   │   ├── page.tsx       # Video dashboard
│   │   │   ├── workspace/[workspaceId]/
│   │   │   │   ├── page.tsx
│   │   │   │   ├── settings/page.tsx
│   │   │   │   └── members/page.tsx
│   │   │   ├── analytics/[videoId]/page.tsx
│   │   │   └── templates/page.tsx
│   │   ├── watch/[slug]/page.tsx     # Public viewer
│   │   ├── embed/[id]/page.tsx       # Embeddable viewer (minimal chrome)
│   │   └── api/
│   │       ├── trpc/[trpc]/route.ts  # tRPC HTTP handler
│   │       ├── oembed/route.ts       # oEmbed endpoint
│   │       ├── upload/
│   │       │   ├── initiate/route.ts # Multipart initiate
│   │       │   ├── presign/route.ts  # Per-part presigned URL
│   │       │   └── complete/route.ts # Multipart complete
│   │       ├── analytics/ingest/route.ts  # View event POST
│   │       └── auth/[...nextauth]/route.ts
│   ├── trpc/
│   │   ├── init.ts            # tRPC + context creation
│   │   ├── client.tsx         # TRPCReactProvider + useTRPC
│   │   ├── query-client.ts    # QueryClient factory
│   │   ├── server.tsx         # createTRPCOptionsProxy for RSC
│   │   └── routers/
│   │       ├── _app.ts        # Root router (merges all)
│   │       ├── video.ts       # CRUD, upload finalize, slug
│   │       ├── workspace.ts   # CRUD, invite, members, roles
│   │       ├── template.ts    # List, fork
│   │       ├── analytics.ts   # Dashboard queries + SSE subscription
│   │       ├── sync.ts        # Desktop sync SSE subscription
│   │       └── user.ts        # Profile, account linking
│   ├── lib/
│   │   ├── prisma.ts          # Singleton PrismaClient
│   │   ├── auth.ts            # NextAuth config export
│   │   ├── r2.ts              # S3Client for R2 + presign helpers
│   │   ├── geo.ts             # MaxMind GeoLite2 reader singleton
│   │   ├── jwt.ts             # Short-lived JWT mint/verify (jose)
│   │   └── constants.ts       # App-wide constants
│   ├── components/            # React components
│   │   ├── video-player.tsx
│   │   ├── chapter-nav.tsx
│   │   ├── analytics-dashboard.tsx
│   │   ├── upload-progress.tsx
│   │   └── ...
│   └── styles/
│       └── globals.css        # Tailwind v4 @theme import
├── public/
│   └── geolite2/              # GeoLite2-Country.mmdb (gitignored, downloaded on deploy)
├── next.config.ts
├── tailwind.config.ts         # (or CSS-first @theme for v4)
├── package.json
└── tsconfig.json
```

### Pattern 1: tRPC Fetch Adapter for App Router
**What:** Use the standard fetch adapter (not `@trpc/next`) for App Router. This gives full RSC support.
**When to use:** All tRPC procedures.
**Example:**
```typescript
// Source: trpc.io/docs/client/nextjs/app-router-setup [CITED]
// app/api/trpc/[trpc]/route.ts
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/trpc/routers/_app';
import { createTRPCContext } from '@/trpc/init';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
  });

export { handler as GET, handler as POST };
```

### Pattern 2: tRPC SSE Subscriptions for Live Sync
**What:** Use `httpSubscriptionLink` with `splitLink` for real-time desktop-web sync. Desktop pushes metadata updates; web subscribers receive them via SSE.
**When to use:** Recording status, analytics real-time updates.
**Example:**
```typescript
// Source: trpc.io/docs/server/subscriptions [CITED]
// trpc/routers/sync.ts
import { tracked } from '@trpc/server';
import { z } from 'zod';
import { EventEmitter, on } from 'node:events';

const syncEmitter = new EventEmitter();

export const syncRouter = t.router({
  onRecordingStatus: t.procedure
    .input(z.object({
      workspaceId: z.string(),
      lastEventId: z.string().nullish(),
    }))
    .subscription(async function* (opts) {
      for await (const [data] of on(syncEmitter, `recording:${opts.input.workspaceId}`, {
        signal: opts.signal,
      })) {
        yield tracked(data.id, data);
      }
    }),
});
```

### Pattern 3: Prisma Singleton with Global Cache
**What:** Prevent Prisma client exhaustion in dev/serverless.
**When to use:** Always.
**Example:**
```typescript
// Source: prisma.io/docs/guides/authjs-nextjs [CITED]
// lib/prisma.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

### Pattern 4: R2 Multipart Presigned URL Flow
**What:** Server generates presigned PUT URLs per chunk; desktop uploads directly to R2.
**When to use:** Video upload (WEB-03).
**Example:**
```typescript
// Source: developers.cloudflare.com/r2/api/s3/presigned-urls/ [CITED]
// lib/r2.ts
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function createPresignedPartUrl(
  bucket: string, key: string, uploadId: string, partNumber: number
): Promise<string> {
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 });
}
```

### Pattern 5: NextAuth v5 with Prisma Adapter
**What:** Database-backed sessions with GitHub + Google OAuth.
**When to use:** All auth.
**Example:**
```typescript
// Source: authjs.dev/getting-started/adapters/prisma [CITED]
// lib/auth.ts
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from './prisma';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [GitHub, Google],
  session: { strategy: 'database' },
  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
});
```

### Anti-Patterns to Avoid
- **Using `@trpc/next` package with App Router:** This package is for Pages Router only. Use the fetch adapter + `@trpc/tanstack-react-query` instead. [CITED: trpc.io/docs/client/nextjs]
- **Direct R2 API credentials in the browser:** Never expose R2 access keys client-side. Always generate presigned URLs server-side. [CITED: Cloudflare R2 docs]
- **Instantiating PrismaClient per request:** Exhausts connection pool. Use the global singleton pattern. [CITED: prisma.io docs]
- **Using EventSource for desktop SSE auth:** EventSource API doesn't support custom headers. Use `httpSubscriptionLink` which sends auth via query param or cookie. [ASSUMED]
- **Using `POST` presigned URLs with R2:** R2 does not support POST-based multipart form uploads via presigned URLs. Use PUT only. [VERIFIED: Cloudflare R2 docs]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OAuth flow | Custom token exchange | NextAuth v5 + Prisma adapter | Handles PKCE, CSRF, session management, provider quirks [CITED: authjs.dev] |
| Presigned URL signing | Manual HMAC-SHA256 SigV4 | `@aws-sdk/s3-request-presigner` | SigV4 is complex; SDK handles region, date, canonical request [CITED: AWS SDK docs] |
| JWT creation/verification | Manual crypto | `jose` library | Edge-compatible, handles JWK, JWS, JWE, claims validation [VERIFIED: npm registry] |
| GeoIP lookup | IP-to-country mapping table | `@maxmind/geoip2-node` + GeoLite2 MMDB | Updated monthly, handles IPv4/IPv6, CIDR edge cases [CITED: dev.maxmind.com] |
| SSE reconnection | Custom EventSource wrapper | tRPC `httpSubscriptionLink` with `tracked()` | Auto-reconnects, resumes from last event ID, handles 5xx retry [CITED: trpc.io] |
| Form validation | Manual checks | `zod` (shared with tRPC input schemas) | Type inference, composable, tRPC-native [VERIFIED: committed stack] |

## Common Pitfalls

### Pitfall 1: NextAuth v5 Beta Instability
**What goes wrong:** API surface changes between beta versions break auth flow.
**Why it happens:** NextAuth v5 has been in beta since 2024; still at beta.31 as of April 2026.
**How to avoid:** Pin exact version `next-auth@5.0.0-beta.31`. Do not use `@latest` or caret ranges. Test auth flow after any version bump. [VERIFIED: npm registry shows no stable 5.x release]
**Warning signs:** Import paths change, `auth()` function signature changes, adapter contract changes.

### Pitfall 2: R2 Multipart Part Size Minimum
**What goes wrong:** Upload fails with opaque error if any non-final part is < 5 MiB.
**Why it happens:** S3 (and R2) enforces minimum 5 MiB per part except the last part.
**How to avoid:** Use 10 MiB chunk size. Validate on desktop before upload. If file < 5 MiB, use single-part PUT (not multipart). [VERIFIED: Cloudflare R2 docs — minimum 5 MiB, max 5 GiB, max 10,000 parts]
**Warning signs:** `EntityTooSmall` errors from R2.

### Pitfall 3: R2 Presigned URLs Only Work on S3 Domain
**What goes wrong:** Presigned URL returns 403 when accessed via custom domain.
**Why it happens:** R2 presigned URLs work exclusively with `<ACCOUNT_ID>.r2.cloudflarestorage.com`. Custom domains do not support presigned URL verification.
**How to avoid:** Always use the S3 API endpoint for upload URLs. Use custom domain only for public read access (viewer page video src). [VERIFIED: Cloudflare R2 docs]
**Warning signs:** `SignatureDoesNotMatch` on custom domain requests.

### Pitfall 4: Prisma Client Bundling in RSC
**What goes wrong:** Prisma client gets bundled into client-side JavaScript, bloating bundle.
**Why it happens:** Next.js App Router tree-shaking doesn't automatically exclude server-only imports.
**How to avoid:** Generate Prisma client to `./generated` directory. Mark files importing Prisma with `import 'server-only'` at the top. Never import Prisma in files that also export client components. [CITED: prisma.io/docs/guides]
**Warning signs:** Large client bundle containing Prisma runtime.

### Pitfall 5: Neon Connection Pooling in Serverless
**What goes wrong:** Connection exhaustion under load; cold starts timeout.
**Why it happens:** Each serverless function invocation creates a new connection if not pooled.
**How to avoid:** Use Neon's pooled connection string (hostname contains `-pooler`). Set `connection_limit=1` in Prisma datasource for serverless. Consider `@neondatabase/serverless` driver adapter for edge functions. [CITED: neon.com/docs/guides/prisma]
**Warning signs:** `P1001: Can't reach database server` errors under load.

### Pitfall 6: SSE Subscriptions on Vercel
**What goes wrong:** Vercel serverless functions have a 10-second (Hobby) or 60-second (Pro) execution timeout. Long-lived SSE connections get killed.
**Why it happens:** Vercel's serverless model is request-response, not long-lived.
**How to avoid:** Use Vercel's streaming response support (App Router `ReadableStream`). For the Pro plan, the 60s timeout is usually sufficient for SSE with periodic keepalives. For truly persistent connections, consider a separate WebSocket server on a platform like Railway/Fly.io, or use Vercel Edge Functions (which have no timeout but limited CPU). [ASSUMED — needs validation against Vercel Pro limits]
**Warning signs:** SSE connections dropping after exactly 10s or 60s.

### Pitfall 7: EventSource Lacks Custom Headers
**What goes wrong:** Cannot send JWT in Authorization header via browser EventSource API.
**Why it happens:** The native EventSource API only supports GET with no custom headers.
**How to avoid:** tRPC's `httpSubscriptionLink` uses `fetch()` under the hood (not EventSource), so it CAN send custom headers. Alternatively, pass JWT as a query parameter in the SSE URL (less ideal but works). [CITED: trpc.io/docs/client/links/httpSubscriptionLink]
**Warning signs:** 401 errors on subscription connections.

### Pitfall 8: Desktop OAuth Flow
**What goes wrong:** OAuth redirect to `http://localhost:PORT/callback` fails or gets blocked.
**Why it happens:** Desktop apps can't use standard web redirects. Need a localhost server to capture the callback.
**How to avoid:** Use `tauri-plugin-oauth` which spawns a temporary localhost server for the redirect. Register `http://localhost` (no specific port) as allowed redirect URI in GitHub/Google OAuth app config. [CITED: github.com/FabianLars/tauri-plugin-oauth]
**Warning signs:** OAuth callback never received; browser shows error page after auth.

## Code Examples

### Multipart Upload Flow (Server-Side tRPC Procedures)
```typescript
// Source: Cloudflare R2 docs + AWS SDK patterns [CITED]
// trpc/routers/video.ts — upload procedures

export const videoRouter = t.router({
  initiateUpload: protectedProcedure
    .input(z.object({
      fileName: z.string(),
      fileSizeBytes: z.number(),
      contentType: z.string().default('video/mp4'),
      workspaceId: z.string(),
      projectName: z.string(),
      storySource: z.string().optional(),
      sceneBoundaries: z.array(z.object({
        sceneIndex: z.number(),
        label: z.string(),
        startTimeSec: z.number(),
      })).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const key = `${input.workspaceId}/${crypto.randomUUID()}/${input.fileName}`;
      const { UploadId } = await r2.send(new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: input.contentType,
        ServerSideEncryption: 'AES256', // DIST-06: encryption at rest
      }));

      // Create video record in DB (status: uploading)
      const video = await ctx.prisma.video.create({
        data: {
          r2Key: key,
          uploadId: UploadId!,
          fileName: input.fileName,
          fileSizeBytes: input.fileSizeBytes,
          status: 'UPLOADING',
          workspaceId: input.workspaceId,
          uploaderId: ctx.user.id,
          projectName: input.projectName,
          storySource: input.storySource,
          sceneBoundaries: input.sceneBoundaries ?? [],
        },
      });

      return { videoId: video.id, uploadId: UploadId!, r2Key: key };
    }),

  getPartPresignedUrl: protectedProcedure
    .input(z.object({
      r2Key: z.string(),
      uploadId: z.string(),
      partNumber: z.number().min(1).max(10000),
    }))
    .mutation(async ({ input }) => {
      const url = await createPresignedPartUrl(
        R2_BUCKET, input.r2Key, input.uploadId, input.partNumber
      );
      return { presignedUrl: url, partNumber: input.partNumber };
    }),

  completeUpload: protectedProcedure
    .input(z.object({
      videoId: z.string(),
      r2Key: z.string(),
      uploadId: z.string(),
      parts: z.array(z.object({
        PartNumber: z.number(),
        ETag: z.string(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      await r2.send(new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: input.r2Key,
        UploadId: input.uploadId,
        MultipartUpload: { Parts: input.parts },
      }));

      // Generate thumbnail from first frame (FFmpeg on server or pre-generated)
      const thumbnailKey = input.r2Key.replace(/\.[^.]+$/, '-thumb.jpg');

      await ctx.prisma.video.update({
        where: { id: input.videoId },
        data: {
          status: 'READY',
          thumbnailR2Key: thumbnailKey,
        },
      });

      return { videoId: input.videoId, status: 'READY' };
    }),
});
```

### oEmbed Endpoint
```typescript
// Source: oembed.com spec [CITED]
// app/api/oembed/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');
  const format = req.nextUrl.searchParams.get('format') ?? 'json';
  const maxWidth = parseInt(req.nextUrl.searchParams.get('maxwidth') ?? '1280');
  const maxHeight = parseInt(req.nextUrl.searchParams.get('maxheight') ?? '720');

  if (!url || format !== 'json') {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Extract slug from URL pattern /watch/<slug>
  const match = url.match(/\/watch\/([a-z0-9-]+)/i);
  if (!match) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const video = await prisma.video.findUnique({
    where: { slug: match[1], status: 'READY' },
  });
  if (!video || !video.isPublic) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Aspect-ratio-aware sizing
  const width = Math.min(maxWidth, 1280);
  const height = Math.min(maxHeight, Math.round(width * 9 / 16));

  return NextResponse.json({
    version: '1.0',
    type: 'rich',
    title: video.projectName,
    provider_name: 'StoryCapture',
    provider_url: 'https://storycapture.app',
    thumbnail_url: `https://cdn.storycapture.app/${video.thumbnailR2Key}`,
    thumbnail_width: 640,
    thumbnail_height: 360,
    html: `<iframe src="https://storycapture.app/embed/${video.id}" width="${width}" height="${height}" frameborder="0" allowfullscreen></iframe>`,
    width,
    height,
  });
}
```

### Desktop Auth Linking (Tauri Side)
```typescript
// Source: tauri-plugin-oauth pattern [CITED: github.com/FabianLars/tauri-plugin-oauth]
// Desktop: Settings > Accounts > "Connect Web Account" button handler
// This runs in the Tauri frontend (React), invoking a Rust command that
// spawns a localhost OAuth server.

async function connectWebAccount() {
  // 1. Desktop spawns localhost server via tauri-plugin-oauth
  const { port } = await invoke('start_oauth_server');

  // 2. Open browser to web companion's /api/auth/signin?callbackUrl=http://localhost:{port}/callback
  await open(`https://storycapture.app/api/auth/signin/github?callbackUrl=http://localhost:${port}/callback`);

  // 3. After user authenticates, NextAuth redirects to localhost:{port}/callback?code=...
  // 4. Rust command captures the code, exchanges it for a session token via the web companion API
  // 5. Store session token in OS keychain via tauri-plugin-keyring

  const result = await invoke('complete_oauth_flow', { port });
  // result contains { userId, email, accessToken, refreshToken }
}
```

### Analytics Event Ingestion
```typescript
// Source: Architecture decision for near-real-time analytics [ASSUMED]
// app/api/analytics/ingest/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { geoReader } from '@/lib/geo';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { videoId, event, timestamp, sessionId, currentScene, watchDurationSec } = body;

  // GeoIP from request
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
  let country = 'XX'; // unknown
  try {
    const geo = geoReader.country(ip);
    country = geo.country?.isoCode ?? 'XX';
  } catch { /* GeoLite2 doesn't cover all IPs */ }

  await prisma.viewEvent.create({
    data: {
      videoId,
      event, // 'play' | 'pause' | 'seek' | 'scene_enter' | 'ended'
      sessionId, // from httpOnly cookie
      timestamp: new Date(timestamp),
      country,
      currentScene,
      watchDurationSec,
    },
  });

  return NextResponse.json({ ok: true });
}
```

## Prisma Schema (Recommended)

```prisma
// Source: Prisma conventions + Auth.js adapter requirements [CITED: authjs.dev]

generator client {
  provider = "prisma-client-js"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── Auth.js required models ───

model User {
  id            String    @id @default(cuid())
  name          String?
  email         String?   @unique
  emailVerified DateTime?
  image         String?
  accounts      Account[]
  sessions      Session[]
  workspaceMemberships WorkspaceMember[]
  videos        Video[]
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  @@unique([identifier, token])
}

// ─── Workspace & RBAC ───

model Workspace {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  isPersonal Boolean @default(false)
  members   WorkspaceMember[]
  videos    Video[]
  invites   WorkspaceInvite[]
  templates Template[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model WorkspaceMember {
  id          String   @id @default(cuid())
  userId      String
  workspaceId String
  role        Role     @default(VIEWER)
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  joinedAt    DateTime  @default(now())
  @@unique([userId, workspaceId])
}

enum Role {
  OWNER
  EDITOR
  VIEWER
}

model WorkspaceInvite {
  id          String   @id @default(cuid())
  email       String
  workspaceId String
  role        Role     @default(VIEWER)
  token       String   @unique @default(cuid())
  expiresAt   DateTime
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  createdAt   DateTime  @default(now())
  @@index([token])
}

// ─── Video & Upload ───

model Video {
  id              String   @id @default(cuid())
  slug            String   @unique
  projectName     String
  fileName        String
  fileSizeBytes   BigInt
  r2Key           String   @unique
  thumbnailR2Key  String?
  uploadId        String?  // S3 multipart upload ID (null after complete)
  status          VideoStatus @default(UPLOADING)
  isPublic        Boolean  @default(false) // D-02: private by default
  storySource     String?  @db.Text // DSL source for display (read-only)
  sceneBoundaries Json     @default("[]") // [{sceneIndex, label, startTimeSec}]
  workspaceId     String
  uploaderId      String
  workspace       Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  uploader        User      @relation(fields: [uploaderId], references: [id])
  viewEvents      ViewEvent[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([workspaceId])
  @@index([slug])
}

enum VideoStatus {
  UPLOADING
  PROCESSING
  READY
  FAILED
}

// ─── Analytics ───

model ViewEvent {
  id              String   @id @default(cuid())
  videoId         String
  event           String   // play, pause, seek, scene_enter, ended
  sessionId       String   // from httpOnly cookie (no PII)
  country         String   @default("XX") // ISO 3166-1 alpha-2
  currentScene    Int?     // scene index from DSL
  watchDurationSec Float?
  timestamp       DateTime @default(now())
  video           Video    @relation(fields: [videoId], references: [id], onDelete: Cascade)
  @@index([videoId, timestamp])
  @@index([videoId, sessionId])
}

// ─── Aggregated analytics (materialized by cron / tRPC mutation) ───

model DailyVideoStats {
  id            String   @id @default(cuid())
  videoId       String
  date          DateTime @db.Date
  totalPlays    Int      @default(0)
  uniquePlays   Int      @default(0)
  avgDurationSec Float   @default(0)
  medianDurationSec Float @default(0)
  countryBreakdown Json  @default("{}") // { "US": 42, "DE": 7, ... }
  sceneDropoffs    Json  @default("[]") // [{ sceneIndex, dropoffCount }]
  @@unique([videoId, date])
  @@index([videoId])
}

// ─── Templates ───

model Template {
  id          String   @id @default(cuid())
  name        String
  description String?  @db.Text
  category    TemplateCategory
  storySource String   @db.Text // DSL content
  thumbnailUrl String?
  workspaceId String?  // null = system template
  workspace   Workspace? @relation(fields: [workspaceId], references: [id])
  forkCount   Int      @default(0)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([category])
}

enum TemplateCategory {
  SAAS_ONBOARDING
  ECOMMERCE_CHECKOUT
  API_WALKTHROUGH
  MOBILE_DEMO
  CLI_TOOL
  LANDING_PAGE
  FEATURE_ANNOUNCEMENT
  BUG_REPRODUCTION
  INTERNAL_TRAINING
}

// ─── Desktop sync (project mirror metadata) ───

model SyncedProject {
  id            String   @id @default(cuid())
  desktopId     String   // UUID from desktop project.sqlite
  workspaceId   String
  projectName   String
  storySource   String?  @db.Text
  recordingStatus String? // "idle" | "recording" | "step:3/7"
  lastSyncedAt  DateTime @default(now())
  @@unique([desktopId, workspaceId])
  @@index([workspaceId])
}
```

## R2 Bucket Structure

**Recommendation:** Hierarchical by workspace, with UUID collision avoidance.

```
storycapture-media/
├── {workspaceId}/
│   ├── {uuid}/
│   │   ├── recording.mp4       # Main video
│   │   ├── recording-thumb.jpg # Auto-generated thumbnail
│   │   └── recording.webm      # (future: alternate format)
│   └── presets/
│       └── {presetId}.scpreset # Shared effect presets
└── templates/
    └── {templateId}/
        └── thumbnail.jpg
```

**Serving strategy:**
- **Uploads:** Presigned PUT URLs via S3 API domain (`<ACCOUNT_ID>.r2.cloudflarestorage.com`)
- **Public reads (viewer page):** Custom domain (`cdn.storycapture.app`) with R2 custom domain or Cloudflare CDN
- **Private reads (dashboard thumbnails):** Presigned GET URLs (short expiry, 1 hour)

## Thumbnail Generation

**Recommendation:** Generate thumbnail on the desktop before upload, include as a second upload. This avoids needing FFmpeg on the server.

**Flow:**
1. Desktop renders the polished video (Phase 2 export pipeline)
2. Desktop extracts first frame as JPEG using the bundled FFmpeg sidecar: `ffmpeg -i output.mp4 -vframes 1 -q:v 2 thumb.jpg`
3. Desktop uploads both `recording.mp4` and `recording-thumb.jpg` to R2
4. Web companion stores `thumbnailR2Key` alongside the video record

This reuses the existing FFmpeg sidecar (ENC-01) and avoids server-side FFmpeg deployment complexity. [ASSUMED — validated by existing desktop FFmpeg capability]

## Desktop-Web Auth Flow

**Recommended approach: OAuth via localhost redirect**

1. User clicks "Connect Web Account" in desktop Settings > Accounts
2. Desktop spawns ephemeral localhost HTTP server via `tauri-plugin-oauth` (Rust)
3. Desktop opens system browser to `https://storycapture.app/api/auth/signin/github` with `callbackUrl=http://localhost:{port}/callback`
4. User authenticates in browser; NextAuth redirects to `http://localhost:{port}/callback` with session cookie
5. Desktop captures the callback, extracts the session token
6. Desktop exchanges session token for a long-lived API token via a dedicated `/api/auth/desktop-token` endpoint
7. API token stored in OS keychain via `tauri-plugin-keyring`
8. For SSE subscriptions, desktop mints short-lived JWT (15 min) from the API token, sends in `Authorization` header

**Why not device code flow:** GitHub supports it but Google does not (Google deprecated it for non-TV apps). Localhost redirect is universal. [ASSUMED]

## SSE vs WebSocket Decision

**Recommendation: tRPC SSE subscriptions (primary) with WebSocket fallback option**

| Factor | SSE (recommended) | WebSocket |
|--------|-------------------|-----------|
| Vercel support | Native (streaming responses) | Requires separate server |
| Setup complexity | Minimal (tRPC built-in) | Needs `ws` server, port config |
| Auth | Via headers or query params | Requires initial handshake |
| Reconnection | Auto with `tracked()` + lastEventId | Manual reconnect logic |
| Direction | Server → client (sufficient for D-07) | Bidirectional (overkill for read-only sync) |
| Desktop → server push | Via tRPC mutation (HTTP POST) | Via same WS connection |

D-07 specifies: recording status is pushed from desktop; web is read-only consumer. This is a perfect SSE use case. Desktop pushes via HTTP mutation; web receives via SSE subscription.

**Vercel SSE gotcha mitigation:** Use Vercel Pro (60s timeout) with 30s SSE keepalive pings. For the analytics real-time dashboard (D-06), aggregate every 30s and push — fits within timeout. If SSE proves insufficient on Vercel Hobby tier, deploy a standalone SSE server on Fly.io or Railway. [ASSUMED — Vercel Pro tier needed]

## Analytics Architecture

### Event Ingestion
- Viewer page sends events via `POST /api/analytics/ingest` (lightweight edge-compatible route)
- Events: `play`, `pause`, `seek`, `scene_enter`, `ended`
- Each event includes: `videoId`, `sessionId` (httpOnly cookie), `currentScene`, `watchDurationSec`, `timestamp`
- GeoIP resolved server-side from `x-forwarded-for` header using MaxMind GeoLite2

### Session Tracking (GDPR-Safe per D-06)
- Generate random `sessionId` cookie on first visit (httpOnly, secure, SameSite=Lax, 30-day expiry)
- No PII stored — no email, no user ID, no fingerprinting
- Cookie is first-party only; no third-party trackers
- Unique play count = `COUNT(DISTINCT sessionId)` per video

### Aggregation Strategy
- **Real-time (near):** tRPC SSE subscription polls `ViewEvent` table every 30s, emits delta to connected dashboard
- **Daily rollup:** Scheduled task (Vercel Cron or pg_cron) aggregates raw events into `DailyVideoStats` at midnight UTC
- **Retention:** Raw `ViewEvent` rows older than 90 days deleted by scheduled task; `DailyVideoStats` kept indefinitely
- **Drop-off heatmap:** Bucket events by `currentScene` from DSL scene boundaries. Count `scene_enter` events per scene; drop-off = `scene_enter[N] - scene_enter[N+1]`

### MaxMind GeoLite2 Integration
- Download `GeoLite2-Country.mmdb` during build/deploy (not committed to git — license requires)
- Use `@maxmind/geoip2-node` with `Reader.open()` for async file read
- Create singleton reader in `lib/geo.ts`
- Country-level only per D-06 (no city-level)
- Update MMDB monthly (MaxMind license requirement: delete within 30 days of new release) [CITED: dev.maxmind.com]

## Workspace & RBAC Implementation

### tRPC Middleware for Role Checking
```typescript
// Source: tRPC middleware pattern [ASSUMED]
const workspaceMemberProcedure = protectedProcedure
  .input(z.object({ workspaceId: z.string() }))
  .use(async ({ ctx, input, next }) => {
    const membership = await ctx.prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: {
          userId: ctx.user.id,
          workspaceId: input.workspaceId,
        },
      },
    });
    if (!membership) throw new TRPCError({ code: 'FORBIDDEN' });
    return next({ ctx: { ...ctx, membership } });
  });

const workspaceEditorProcedure = workspaceMemberProcedure
  .use(async ({ ctx, next }) => {
    if (ctx.membership.role === 'VIEWER') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Editor role required' });
    }
    return next();
  });
```

### Invite Flow
1. Owner/editor calls `workspace.invite` mutation with email + role
2. Server creates `WorkspaceInvite` row with random token + 7-day expiry
3. Server sends invite email (use Resend or Vercel email service)
4. Recipient clicks link → `/invite/{token}` → auto-joins workspace if authenticated, or sign-in first
5. Token consumed (deleted) after use

### Auto-Created Personal Workspace
On first sign-in, NextAuth `events.createUser` callback creates a personal workspace with `isPersonal: true` and the user as `OWNER`.

## Template Marketplace

### Fork Mechanics
1. User browses templates by category grid (9 categories per D-05)
2. Clicks "Use Template" → tRPC `template.fork` mutation
3. Server deep-copies `storySource` into a new project in the user's workspace
4. Increments `forkCount` on the source template
5. User is redirected to the desktop app to open the forked project (via deep link or manual)

### Seed Data
Planner should create a seed script (`prisma/seed.ts`) that inserts the 10-15 curated templates with sample DSL content for each category.

## Environment Variables

```bash
# Neon PostgreSQL
DATABASE_URL="postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/storycapture?sslmode=require"

# NextAuth
AUTH_SECRET="..." # openssl rand -base64 32
AUTH_GITHUB_ID="..."
AUTH_GITHUB_SECRET="..."
AUTH_GOOGLE_ID="..."
AUTH_GOOGLE_SECRET="..."
AUTH_URL="https://storycapture.app" # production URL

# Cloudflare R2
R2_ACCOUNT_ID="..."
R2_ACCESS_KEY_ID="..."
R2_SECRET_ACCESS_KEY="..."
R2_BUCKET="storycapture-media"
R2_PUBLIC_URL="https://cdn.storycapture.app" # custom domain for public reads

# JWT (desktop auth tokens)
JWT_SECRET="..." # openssl rand -base64 32

# MaxMind
MAXMIND_LICENSE_KEY="..." # for downloading GeoLite2 MMDB
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Pages Router + `@trpc/next` | App Router + fetch adapter + `@trpc/tanstack-react-query` | tRPC v11 (2025) | No `@trpc/next` needed; RSC support via `createTRPCOptionsProxy` [CITED: trpc.io] |
| tRPC WebSocket subscriptions | tRPC SSE subscriptions via `httpSubscriptionLink` | tRPC v11 (2025) | SSE is now recommended default; simpler, no WS server needed [CITED: trpc.io] |
| `NEXTAUTH_URL` / `NEXTAUTH_SECRET` env vars | `AUTH_URL` / `AUTH_SECRET` env vars | Auth.js v5 | Prefix changed from `NEXTAUTH_` to `AUTH_` [CITED: authjs.dev/migrating-to-v5] |
| `@next-auth/prisma-adapter` | `@auth/prisma-adapter` | Auth.js v5 | Package scope changed [CITED: authjs.dev] |
| Prisma `@prisma/client` import from `node_modules` | Generate to `./generated` + import from there | Prisma 5+ | Avoids RSC bundling issues [CITED: prisma.io docs] |
| Neon: separate pooled + direct connection strings | Single pooled string works for both queries + migrations | PgBouncer 1.22 + Prisma 5.10 | Simplified config [CITED: neon.com docs] |

**Deprecated/outdated:**
- `@trpc/next` — still works for Pages Router but not needed/recommended for App Router [CITED: trpc.io]
- `NEXTAUTH_URL` / `NEXTAUTH_SECRET` — replaced by `AUTH_URL` / `AUTH_SECRET` in v5 [CITED: authjs.dev]
- Tauri Stronghold — deprecated, do not use for desktop token storage [VERIFIED: CLAUDE.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Use latest Next.js (16.x) and Prisma (7.x) instead of CLAUDE.md-specified 15.x/6.x | Standard Stack | Low — both are backward compatible; user can pin older versions |
| A2 | Database sessions preferred over JWT sessions for NextAuth | Alternatives Considered | Low — JWT sessions are a simple config change |
| A3 | Google does not support device code flow for non-TV apps | Desktop Auth Flow | Medium — if wrong, device code flow would be simpler than localhost redirect |
| A4 | Vercel Pro tier needed for SSE (60s timeout vs 10s Hobby) | SSE vs WebSocket | High — if Hobby tier only, need external SSE server |
| A5 | Thumbnail generation on desktop before upload is preferred | Thumbnail Generation | Low — can add server-side FFmpeg later |
| A6 | EventSource API limitation (no custom headers) mitigated by tRPC's fetch-based SSE | Pitfall 7 | Medium — if tRPC uses native EventSource internally, auth breaks |
| A7 | Email sending for workspace invites needs Resend or similar service | Workspace RBAC | Low — can defer email to v2 and use copy-link invite |

## Open Questions

1. **Next.js version: 15.x or 16.x?**
   - What we know: CLAUDE.md specifies 15.x; npm latest is 16.2.x (stable since early 2026)
   - What's unclear: Whether the user wants to match CLAUDE.md exactly or use latest stable
   - Recommendation: Use 15.3.9 (latest 15.x) to match CLAUDE.md; upgrade to 16.x is a separate decision

2. **Vercel plan tier?**
   - What we know: SSE needs long-lived connections; Hobby tier has 10s function timeout
   - What's unclear: Whether the project will be on Hobby or Pro
   - Recommendation: Design for Pro (60s timeout). If Hobby only, use polling instead of SSE for analytics dashboard, or deploy SSE endpoint on Fly.io

3. **Email service for workspace invites?**
   - What we know: D-04 requires invite by email; no email service is in the committed stack
   - What's unclear: Which email provider to use (Resend, SendGrid, Vercel email)
   - Recommendation: Start with copy-to-clipboard invite link; add email sending as enhancement

4. **Video serving: R2 custom domain or presigned GETs?**
   - What we know: Public videos need to be streamable; private videos need auth
   - What's unclear: Whether to set up R2 custom domain immediately
   - Recommendation: Use presigned GET URLs initially (works without custom domain setup). Add R2 custom domain for public videos later for cleaner URLs and CDN caching.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Next.js runtime | Needs check | >=20 required | — |
| pnpm | Package management | Assumed (existing monorepo uses it) | 9.x | — |
| PostgreSQL (Neon) | Prisma/data layer | External service | — | Local PostgreSQL for dev |
| Cloudflare R2 | Video storage | External service | — | Local MinIO for dev |
| MaxMind GeoLite2 MMDB | Analytics geo | Downloadable | — | Skip geo, default to "XX" |
| Vercel | Deployment | External service | — | Self-host Next.js |

**Missing dependencies with no fallback:**
- None — all external services have free tiers per D-08

**Missing dependencies with fallback:**
- GeoLite2 MMDB requires free MaxMind account + license key to download. Fallback: skip geo entirely, all countries = "XX"
- R2 for local dev: use MinIO as S3-compatible local substitute

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | NextAuth v5 (OAuth 2.0 + PKCE) |
| V3 Session Management | yes | NextAuth database sessions (httpOnly, secure, SameSite) |
| V4 Access Control | yes | tRPC middleware role checks (workspace RBAC) |
| V5 Input Validation | yes | Zod schemas on all tRPC inputs |
| V6 Cryptography | yes | `jose` for JWT; R2 AES256 at rest; HTTPS in transit |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| IDOR on video/workspace resources | Tampering | tRPC middleware verifies workspace membership before any data access |
| Presigned URL leakage | Information Disclosure | Short expiry (1 hour for uploads); PUT-only (no GET) for upload URLs |
| Session fixation | Spoofing | NextAuth regenerates session token on sign-in |
| CSRF on mutations | Tampering | tRPC uses POST for mutations; NextAuth CSRF token |
| XSS in embed iframe | Tampering | iframe sandbox attributes; CSP headers on embed page |
| Slug enumeration on /watch/ | Information Disclosure | Private videos return 404 (not 403) to prevent enumeration |
| JWT theft for SSE | Spoofing | 15-minute expiry; refresh token rotation; revocation via DB session check |

## Sources

### Primary (HIGH confidence)
- [tRPC v11 Next.js App Router setup](https://trpc.io/docs/client/nextjs/app-router-setup) — full file structure, fetch adapter, RSC caller, hydration
- [tRPC v11 subscriptions](https://trpc.io/docs/server/subscriptions) — SSE setup, `tracked()`, reconnection, async generators
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) — generation, limitations, domain constraints
- [Cloudflare R2 multipart upload](https://developers.cloudflare.com/r2/objects/upload-objects/) — part sizes, completion, lifecycle
- [Auth.js Prisma adapter](https://authjs.dev/getting-started/adapters/prisma) — schema, configuration, session strategy
- [Auth.js v5 migration](https://authjs.dev/getting-started/migrating-to-v5) — env var changes, API changes
- [Neon + Prisma guide](https://neon.com/docs/guides/prisma) — connection pooling, serverless driver
- [oEmbed specification](https://oembed.com/) — response format, rich type, discovery
- [MaxMind GeoIP2 Node.js](https://github.com/maxmind/GeoIP2-node) — MMDB reader, async/sync API

### Secondary (MEDIUM confidence)
- [tRPC + Prisma + Next.js production API (2026)](https://noqta.tn/en/tutorials/trpc-prisma-nextjs-production-api-2026) — project structure conventions
- [Tauri OAuth patterns](https://dev.to/datner/tauri-oauth2-5f1h) — localhost redirect flow
- [tauri-plugin-oauth](https://github.com/FabianLars/tauri-plugin-oauth) — ephemeral localhost server for OAuth callback

### Tertiary (LOW confidence)
- Vercel SSE timeout limits — could not find authoritative current documentation on exact limits per plan tier
- Google device code flow deprecation for non-TV apps — based on training knowledge, not verified

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions verified against npm registry
- Architecture: HIGH — patterns verified against official tRPC and Next.js documentation
- Auth flow: MEDIUM — desktop OAuth linking is a known pattern but exact integration with NextAuth v5 needs prototyping
- Analytics: MEDIUM — architecture is sound but aggregation performance at scale is unverified
- Pitfalls: HIGH — documented from official sources and known issues

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (30 days — stable stack, but NextAuth beta may release new versions)
