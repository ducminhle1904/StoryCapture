import "server-only";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * R2 S3-compatible client + presigned URL helpers.
 *
 * CRITICAL: All presigned URLs use the S3 API domain
 * (`<ACCOUNT_ID>.r2.cloudflarestorage.com`), NOT a custom domain.
 * Custom domains do not support presigned URL verification.
 *
 * All uploads use ServerSideEncryption: AES256 (SSE-S3).
 */

export const R2_BUCKET = process.env.R2_BUCKET ?? "storycapture-media";

const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials:
    r2AccessKeyId && r2SecretAccessKey
      ? { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey }
      : undefined,
});

/**
 * Create a presigned PUT URL for uploading a single part of a multipart upload.
 * Expires in 1 hour, part-specific (partNumber encoded in signature).
 */
export async function createPresignedPartUrl(
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(r2Client, command, { expiresIn: 3600 });
}

// ── Presigned GET URL cache (55-minute TTL for 1-hour expiry URLs) ──

const GET_URL_CACHE = new Map<string, { url: string; expiresAt: number }>();
const GET_URL_TTL_MS = 55 * 60 * 1000; // 55 minutes

/**
 * Create a presigned GET URL for reading an object (thumbnails, private videos).
 * Expires in 1 hour. Cached for 55 minutes to avoid re-signing on every request.
 */
export async function createPresignedGetUrl(bucket: string, key: string): Promise<string> {
  const cacheKey = `${bucket}:${key}`;
  const cached = GET_URL_CACHE.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.url;
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  const url = await getSignedUrl(r2Client, command, { expiresIn: 3600 });

  GET_URL_CACHE.set(cacheKey, { url, expiresAt: now + GET_URL_TTL_MS });

  return url;
}

/**
 * Create a presigned PUT URL for a single object upload (thumbnails, small files).
 * Expires in 1 hour. Includes SSE-S3 encryption.
 */
export async function createPresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ServerSideEncryption: "AES256",
  });
  return getSignedUrl(r2Client, command, { expiresIn: 3600 });
}

export {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
};
