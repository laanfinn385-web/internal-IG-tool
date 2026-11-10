// Cloudflare R2 (S3-compatible) client — replaces Vercel Blob for video
// storage specifically. R2's free tier (10GB storage, 1M+ writes/month) is
// roughly 10x Vercel Blob's Hobby-plan ceiling, and — unlike Vercel Blob on
// Hobby — going over it doesn't suspend the whole store (reads included)
// for everything using it; it just stops free uploads until the next cycle
// or a payment method is added. See video-render-service/README.md for the
// one-time Cloudflare setup steps.
const { S3Client, PutObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

function getR2Client() {
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
  });
}

function missingConfigError() {
  return new Error('R2 is not configured (R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_BASE_URL).');
}

// Uploads and returns the object's public URL (R2_PUBLIC_BASE_URL + key) —
// the bucket needs public access enabled (its own r2.dev URL, or a
// connected custom domain) for this URL to actually be fetchable, same as
// Vercel Blob's `access: 'public'` did before.
async function uploadToR2(key, buffer, contentType) {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!client || !bucket || !publicBase) throw missingConfigError();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
  return `${publicBase.replace(/\/$/, '')}/${key}`;
}

// Best-effort, mirrors deleteVideoBlobs' own "never block the caller on a
// cleanup failure" reasoning in the main app — silently skips (not throws)
// if R2 isn't configured, or if a given URL doesn't actually belong to this
// bucket's public base (nothing to key off otherwise).
async function deleteFromR2(urls) {
  const client = getR2Client();
  const bucket = process.env.R2_BUCKET_NAME;
  const publicBase = process.env.R2_PUBLIC_BASE_URL;
  if (!client || !bucket || !publicBase) return;
  const base = publicBase.replace(/\/$/, '');
  const keys = (urls || [])
    .filter(Boolean)
    .filter((u) => u.startsWith(base + '/'))
    .map((u) => u.slice(base.length + 1));
  if (keys.length === 0) return;
  await client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: keys.map((Key) => ({ Key })) }
  }));
}

module.exports = { uploadToR2, deleteFromR2 };
