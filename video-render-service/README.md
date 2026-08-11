# video-render-service

Isolated Vercel project that burns a "Hey {name}" text overlay onto a base DM
video and uploads the result to Vercel Blob. Kept separate from the main
outreach tool deployment so ffmpeg's binary doesn't add to the bundle size /
cold start of every other route in that app.

## ffmpeg binary

The ffmpeg binary is a linux64-gpl static build from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) — but it isn't
in this repo. At ~140MB it's over GitHub's 100MB file size limit, so it's
hosted in the same Blob store the rendered videos go to
(`system/ffmpeg-linux-x64`, uploaded once manually) and `api/render.js`
downloads it into `/tmp` on cold start, cached there for any warm
invocations of the same instance. If that Blob URL ever needs to change
(re-uploaded elsewhere, moved to a different store), update
`FFMPEG_BLOB_URL` in `api/render.js`.

That wasn't the first choice — `ffmpeg-static` (npm) was tried first and
looked fine locally (macOS binary has drawtext), but its Linux x64 binary
turned out to have **no `drawtext` filter compiled in at all**, confirmed by
running `strings` on the actual binary and finding zero occurrences of
"drawtext", despite its build flags claiming `--enable-libfreetype`. This
only surfaced once deployed to Vercel's Linux runtime — the macOS/Linux
binaries a single npm package ships are not guaranteed to have the same
filter set. The BtbN build was verified (via the same `strings` inspection)
to have drawtext + freetype + fontconfig actually compiled in before
switching to it.

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

The bundled ffmpeg binary is Linux x64 only, so it can't run directly on a
non-Linux dev machine. It was verified two ways instead:
- The command/filter logic (drawtext syntax, text positioning, timing) was
  verified end-to-end using a locally-installed ffmpeg build (any platform)
  against both a synthetic test clip and the real base video, visually
  confirmed by extracting frames.
- The exact bundled Linux binary was verified by inspecting its contents
  (`strings assets/ffmpeg-linux-x64 | grep drawtext`) rather than executing
  it, since no Linux/x86_64 execution environment was available. Full
  execution was confirmed by an actual deployment + live request.

There's no local Vercel dev server set up here (no `vercel` CLI in this
environment). The ffmpeg command itself was verified locally against a
synthetic test clip; the `/api/render` handler and Blob upload still need an
end-to-end test against a real deployment once `BLOB_READ_WRITE_TOKEN` and
the real base video are in place.
