const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { put } = require('@vercel/blob');
const fontkit = require('fontkit');

const BASE_VIDEO_PATH = path.join(__dirname, '..', 'assets', 'base-video.mp4');
const FONT_PATH = path.join(__dirname, '..', 'assets', 'Inter.ttf');
// Inter has no emoji glyphs at all (confirmed: freetype renders a "no glyph"
// box for U+1F44B) — text-only fonts generally don't ship pictographs. This
// needs to be a *monochrome/outline* emoji font, not a color one: drawtext's
// freetype rendering can't do color bitmap or SVG glyphs, only outlines it
// fills with fontcolor. Noto Emoji (not Noto Color Emoji) is built for
// exactly this.
const EMOJI_FONT_PATH = path.join(__dirname, '..', 'assets', 'NotoEmoji.ttf');
const WAVE_EMOJI = String.fromCodePoint(0x1F44B);

// The base video's dimensions, hardcoded rather than probed at render time
// (no bundled ffprobe) — update these if base-video.mp4 is ever swapped for
// a different resolution.
const BASE_VIDEO_WIDTH = 1080;
const BASE_VIDEO_HEIGHT = 1920;

const interFont = fontkit.openSync(FONT_PATH);
const emojiFont = fontkit.openSync(EMOJI_FONT_PATH);

// ffmpeg's drawtext has no way to position one filter's text relative to
// another's computed width (text_w is only usable within that same filter's
// own expressions), so getting "Hey {name}" and the wave emoji to sit
// side-by-side in their own boxes — rather than two separate drawtext calls
// each self-centering and overlapping — means computing both boxes' pixel
// widths ourselves, using the exact font files ffmpeg will render with.
function measureTextWidth(font, text, fontSize) {
  const run = font.layout(text);
  let widthInUnits = 0;
  for (const glyph of run.glyphs) widthInUnits += glyph.advanceWidth;
  return (widthInUnits / font.unitsPerEm) * fontSize;
}

// Not bundled with the deployment — a linux64-gpl static build from
// BtbN/FFmpeg-Builds is ~140MB, over GitHub's 100MB file size limit, so it
// can't be committed to the repo this project deploys from. Hosted in the
// same Blob store instead and fetched into /tmp on cold start (cached there
// across warm invocations of the same instance, so this only costs a
// download once per cold start, not once per request).
//
// This isn't the binary `ffmpeg-static` (npm) would have installed — that
// package's Linux x64 build genuinely has no `drawtext` filter compiled in
// at all despite claiming --enable-libfreetype (confirmed by running
// `strings` on the actual binary: zero occurrences of "drawtext"). That only
// surfaced once deployed to Linux, not testing locally on macOS. This BtbN
// build was verified the same way to actually have drawtext compiled in.
const FFMPEG_BLOB_URL = 'https://rvpmbm5wpdb082rr.public.blob.vercel-storage.com/system/ffmpeg-linux-x64';
const FFMPEG_LOCAL_PATH = '/tmp/ffmpeg-linux-x64';

async function ensureFfmpegBinary() {
  if (fs.existsSync(FFMPEG_LOCAL_PATH)) return FFMPEG_LOCAL_PATH;
  const res = await fetch(FFMPEG_BLOB_URL);
  if (!res.ok) throw new Error(`Could not download ffmpeg binary (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  // Write under a temp name and rename into place — avoids a concurrent
  // request seeing a partially-written file if two cold starts race.
  const tmpPath = `${FFMPEG_LOCAL_PATH}.${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, buffer, { mode: 0o755 });
  fs.renameSync(tmpPath, FFMPEG_LOCAL_PATH);
  return FFMPEG_LOCAL_PATH;
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => reject(new Error(`Could not start ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      // ffmpeg's real error is usually in the last few lines of stderr, not the top.
      const tail = stderr.trim().split('\n').slice(-15).join('\n');
      reject(new Error(`ffmpeg exited with code ${code}: ${tail || '(no stderr output)'}`));
    });
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // This endpoint is reachable at a public Vercel URL (it's a separate
  // deployment from the main app), so it needs its own auth rather than
  // relying on the main app's session/UI to be the only caller.
  const expectedSecret = process.env.RENDER_SERVICE_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ error: 'RENDER_SERVICE_SECRET is not configured on the render service.' });
    return;
  }
  if (req.headers['x-render-secret'] !== expectedSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const name = (body && body.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  // Keep the blob pathname stable-ish but collision-free without leaking the
  // raw name into a public URL path.
  const pathnameSafeId = (body && body.leadId) ? String(body.leadId) : crypto.randomUUID();

  if (!fs.existsSync(BASE_VIDEO_PATH)) {
    res.status(500).json({ error: `Base video not found at ${BASE_VIDEO_PATH}. It needs to be added to video-render-service/assets/base-video.mp4 and redeployed.` });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN is not configured on the render service.' });
    return;
  }

  const workDir = '/tmp';
  const nameTextPath = path.join(workDir, `text-name-${crypto.randomUUID()}.txt`);
  const emojiTextPath = path.join(workDir, `text-emoji-${crypto.randomUUID()}.txt`);
  const outputPath = path.join(workDir, `out-${crypto.randomUUID()}.mp4`);

  try {
    const ffmpegPath = await ensureFfmpegBinary();

    // textfile= (rather than text='...') sidesteps ffmpeg's filtergraph
    // string-escaping rules entirely — a name with an apostrophe, colon, or
    // accented character would otherwise need careful manual escaping.
    const nameText = `Hey ${name}`;
    fs.writeFileSync(nameTextPath, nameText, 'utf8');
    fs.writeFileSync(emojiTextPath, WAVE_EMOJI, 'utf8');

    const fontSize = BASE_VIDEO_HEIGHT * 0.055;
    const boxBorderW = 20;
    const gapPx = 14;
    const nameWidth = measureTextWidth(interFont, nameText, fontSize);
    const emojiWidth = measureTextWidth(emojiFont, WAVE_EMOJI, fontSize);
    const nameBoxWidth = nameWidth + boxBorderW * 2;
    const emojiBoxWidth = emojiWidth + boxBorderW * 2;
    const combinedWidth = nameBoxWidth + gapPx + emojiBoxWidth;
    const nameBoxX = (BASE_VIDEO_WIDTH - combinedWidth) / 2;
    const emojiBoxX = nameBoxX + nameBoxWidth + gapPx;

    const nameDrawtext = 'drawtext=' + [
      `fontfile=${FONT_PATH}`,
      `textfile=${nameTextPath}`,
      'fontcolor=white',
      `fontsize=${fontSize}`,
      'box=1',
      'boxcolor=black@0.5',
      `boxborderw=${boxBorderW}`,
      `x=${nameBoxX + boxBorderW}`,
      'y=h*0.08',
      "enable='between(t,0,3)'"
    ].join(':');

    const emojiDrawtext = 'drawtext=' + [
      `fontfile=${EMOJI_FONT_PATH}`,
      `textfile=${emojiTextPath}`,
      'fontcolor=white',
      `fontsize=${fontSize}`,
      'box=1',
      'boxcolor=black@0.5',
      `boxborderw=${boxBorderW}`,
      `x=${emojiBoxX + boxBorderW}`,
      'y=h*0.08',
      "enable='between(t,0,3)'"
    ].join(':');

    await runFfmpeg(ffmpegPath, [
      '-y',
      '-i', BASE_VIDEO_PATH,
      '-vf', `${nameDrawtext},${emojiDrawtext}`,
      '-c:v', 'libx264',
      '-preset', 'superfast',
      '-crf', '23',
      '-c:a', 'copy',
      outputPath
    ]);

    const fileBuffer = fs.readFileSync(outputPath);
    const blob = await put(`personalized-videos/${pathnameSafeId}-${Date.now()}.mp4`, fileBuffer, {
      access: 'public',
      contentType: 'video/mp4',
      addRandomSuffix: true
    });

    res.status(200).json({ url: blob.url, name });
  } catch (err) {
    console.error('Render failed:', err);
    res.status(500).json({ error: err.message || 'Video render failed' });
  } finally {
    // /tmp can persist across warm invocations of the same instance, so
    // clean up rather than letting temp files accumulate.
    for (const p of [nameTextPath, emojiTextPath, outputPath]) {
      try { fs.unlinkSync(p); } catch (e) { /* not created, or already gone */ }
    }
  }
};
