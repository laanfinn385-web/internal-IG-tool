# video-render-service

Isolated Vercel project that burns a "Hey {name} 👋" overlay onto a base DM
video and uploads the result to Cloudflare R2. Kept separate from the main
outreach tool deployment so ffmpeg's binary doesn't add to the bundle size /
cold start of every other route in that app.

Originally uploaded to Vercel Blob instead of R2 — moved off it after that
store got suspended (`limits-exceeded-suspended`) for going over Hobby's 1GB
storage cap, which also made it 403 on *reads* (including the ffmpeg binary
below), blocking rendering entirely regardless of where new videos went.
R2's free tier is far larger (10GB storage, 1M+ writes/month) and — as far
as could be found — doesn't suspend the whole bucket's reads the same way
on overage.

## The emoji

The wave is a real color emoji image (`assets/wave-emoji.png`, Twemoji,
CC-BY 4.0 — see `assets/Twemoji-LICENSE.txt`), composited with ffmpeg's
`overlay` filter, not drawn as a font glyph. Two text-based approaches were
tried and rejected first:
- Inter (the name's font) has no emoji glyphs at all — freetype rendered a
  literal "no glyph" box.
- A monochrome/outline emoji font (Noto Emoji) rendered *something*, but
  read as an obviously bolted-on UI element rather than the actual emoji
  people recognize — freetype's drawtext can't do color bitmap/SVG glyphs at
  all, so a "real-looking" emoji was never achievable through text rendering
  here, only through compositing an actual image.

Since ffmpeg has no way to position one filter's output relative to
another's computed size, the name+emoji box is drawn manually (`drawbox`)
sized from widths measured with `fontkit` against the exact font file, with
the emoji placed right after — see the comments in `api/render.js`.

## ffmpeg binary

The ffmpeg binary is a linux64-gpl static build from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) — but it isn't
in this repo. At 150-180MB (varies by build) it's over GitHub's 100MB file
size limit, so it's hosted in the same R2 bucket the rendered videos go to
(uploaded once manually to a `system/` prefix) and `api/render.js` downloads
it from `FFMPEG_BINARY_URL` into `/tmp` on cold start, cached there for any
warm invocations of the same instance. If it ever needs to move (re-
uploaded, different bucket), update the `FFMPEG_BINARY_URL` env var — no
code change needed.

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

1. **Add the base video(s).** Place your DM video at `assets/base-video.mp4`
   and, if using the follow-up video feature, `assets/base-video-followup.mp4`
   (must be committed to git — this project deploys via Vercel's GitHub
   integration, so anything gitignored never reaches the build).
2. **Create a Vercel project** pointing at this subdirectory: in the Vercel
   dashboard, "Add New Project" → import this repo → set **Root Directory**
   to `video-render-service`.
3. **Create a Cloudflare R2 bucket**: Cloudflare dashboard → R2 Object
   Storage → Create bucket. Enable public access on it (bucket Settings →
   Public access → allow the bucket's `r2.dev` subdomain, or connect a
   custom domain) — rendered videos need a plain public URL, same as Vercel
   Blob's `access: 'public'` gave before.
4. **Create an R2 API token**: R2 → Manage R2 API Tokens → Create API Token
   → Object Read & Write, scoped to that bucket → Create. This gives an
   Access Key ID, Secret Access Key, and the account's S3-compatible
   endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
5. **Upload the ffmpeg binary once** to that bucket (e.g. under
   `system/ffmpeg-linux-x64`) — same BtbN build described above, verified
   with `strings <binary> | grep -c '^drawtext$'` before uploading.
6. **Set environment variables** on this Vercel project:
   - `R2_ENDPOINT` — the account endpoint from step 4.
   - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — from step 4.
   - `R2_BUCKET_NAME` — the bucket's name.
   - `R2_PUBLIC_BASE_URL` — the bucket's public URL from step 3 (e.g.
     `https://pub-xxxx.r2.dev`), no trailing slash.
   - `FFMPEG_BINARY_URL` — the public URL of the file uploaded in step 5.
   - `RENDER_SERVICE_SECRET` — any long random string you generate yourself
     (e.g. `openssl rand -hex 32`). This is checked against the `x-render-secret`
     header on every request, since this endpoint has its own public URL.
7. Set the **same** `RENDER_SERVICE_SECRET` value, plus this project's
   deployed URL, as `RENDER_SERVICE_URL` / `RENDER_SERVICE_SECRET` env vars
   on the **main** instagram-outreach-tool project — that's how it
   authenticates to this one.
8. Confirm **Fluid Compute** is enabled on this project (Project Settings →
   Functions) — `vercel.json` requests a 300s `maxDuration`, which only
   applies with Fluid Compute on the Hobby plan.

## API

`POST /api/render`

Headers: `x-render-secret: <RENDER_SERVICE_SECRET>`

Body: `{ "name": "Brad", "leadId": "optional-uuid-for-the-blob-pathname" }`

Response: `{ "url": "https://pub-xxxx.r2.dev/...mp4", "name": "Brad" }`
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

There's no local Vercel dev server set up here. The ffmpeg command itself
was verified locally against a synthetic test clip; the `/api/render`
handler and R2 upload were verified end-to-end against a real deployment
once the R2 env vars and the real base video were in place.
