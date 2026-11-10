const { deleteFromR2 } = require('../lib/r2');

// Deletes one or more rendered videos from R2. Lives here (rather than the
// main app talking to R2 directly) so the main app doesn't need its own R2
// credentials — it reuses this project's existing config and the same
// shared-secret auth as /api/render.
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
    await deleteFromR2(urls);
    res.status(200).json({ ok: true, deleted: urls.length });
  } catch (err) {
    console.error('Delete failed:', err);
    res.status(500).json({ error: err.message || 'R2 deletion failed' });
  }
};
