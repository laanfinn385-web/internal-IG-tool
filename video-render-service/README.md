# video-render-service

Isolated Vercel project that burns a "Hey {name}" text overlay onto a base DM
video and uploads the result to Vercel Blob. Kept separate from the main
outreach tool deployment so ffmpeg's binary (~75-100MB) doesn't add to the
bundle size / cold start of every other route in that app.

## One-time setup

1. **Add the base video.** Place your DM video at `assets/base-video.mp4`
   (must be committed to git — this project deploys via Vercel's GitHub
   integration, so anything gitignored never reaches the build).
2. **Create a Vercel project** pointing at this subdirectory: in the Vercel
   dashboard, "Add New Project" → import this repo → set **Root Directory**
   to `video-render-service`.
3. **Create (or reuse) a Vercel Blob store** — Storage tab → Create → Blob.
   Connect it to this project (or copy its `BLOB_READ_WRITE_TOKEN` into this
   project's env vars manually).
4. **Set environment variables** on this Vercel project:
   - `BLOB_READ_WRITE_TOKEN` — from the Blob store.
   - `RENDER_SERVICE_SECRET` — any long random string you generate yourself
     (e.g. `openssl rand -hex 32`). This is checked against the `x-render-secret`
     header on every request, since this endpoint has its own public URL.
5. Set the **same** `RENDER_SERVICE_SECRET` value, plus this project's
   deployed URL, as `RENDER_SERVICE_URL` / `RENDER_SERVICE_SECRET` env vars
   on the **main** instagram-outreach-tool project — that's how it
   authenticates to this one.
6. Confirm **Fluid Compute** is enabled on this project (Project Settings →
   Functions) — `vercel.json` requests a 300s `maxDuration`, which only
   applies with Fluid Compute on the Hobby plan.

## API

`POST /api/render`

Headers: `x-render-secret: <RENDER_SERVICE_SECRET>`

Body: `{ "name": "Brad", "leadId": "optional-uuid-for-the-blob-pathname" }`

Response: `{ "url": "https://...blob.vercel-storage.com/...mp4", "name": "Brad" }`
or `{ "error": "..." }` with a non-2xx status.

## Local testing

```
npm install
node -e "require('./api/render')" # not directly runnable — see the test
                                    # snippets used during development, which
                                    # exercised the ffmpeg command directly
                                    # against a synthetic testsrc clip.
```

There's no local Vercel dev server set up here (no `vercel` CLI in this
environment). The ffmpeg command itself was verified locally against a
synthetic test clip; the `/api/render` handler and Blob upload still need an
end-to-end test against a real deployment once `BLOB_READ_WRITE_TOKEN` and
the real base video are in place.
