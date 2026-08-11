const { del } = require('@vercel/blob');

// Deletes one or more rendered videos from Blob storage. Lives here (rather
// than the main app calling @vercel/blob directly) so the main app doesn't
// need its own BLOB_READ_WRITE_TOKEN — it reuses this project's existing
// token and the same shared-secret auth as /api/render.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
  const urls = Array.isArray(body && body.urls) ? body.urls.filter((u) => typeof u === 'string' && u) : [];
  if (urls.length === 0) {
    res.status(400).json({ error: 'urls (non-empty array) is required' });
    return;
  }

  try {
    await del(urls);
    res.status(200).json({ ok: true, deleted: urls.length });
  } catch (err) {
    console.error('Delete failed:', err);
    res.status(500).json({ error: err.message || 'Blob deletion failed' });
  }
};
