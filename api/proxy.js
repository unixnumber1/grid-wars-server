const VPS_URL = 'http://93.123.30.179:3000';

export default async function handler(req, res) {
  const path = req.query.path;
  if (!path) return res.status(400).json({ error: 'path query param required' });

  try {
    const fetchOpts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(`${VPS_URL}${path}`, fetchOpts);
    const data = await response.json();

    res.status(response.status).json(data);
  } catch (err) {
    console.error('[proxy] error:', err.message);
    res.status(502).json({ error: 'VPS unavailable', message: err.message });
  }
}
