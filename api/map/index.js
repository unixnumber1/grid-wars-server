import { supabase } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';

const RADIUS_METERS = 1000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  // Bounding box approximation (1 degree lat ≈ 111km)
  const latDelta = RADIUS_METERS / 111000;
  const lngDelta = RADIUS_METERS / (111000 * Math.cos((lat * Math.PI) / 180));

  const latMin = lat - latDelta;
  const latMax = lat + latDelta;
  const lngMin = lng - lngDelta;
  const lngMax = lng + lngDelta;

  const [{ data: hqRaw }, { data: minesRaw }] = await Promise.all([
    supabase
      .from('headquarters')
      .select('*, players(telegram_id, username)')
      .gte('lat', latMin)
      .lte('lat', latMax)
      .gte('lng', lngMin)
      .lte('lng', lngMax),
    supabase
      .from('mines')
      .select('*, players!mines_owner_id_fkey(telegram_id, username)')
      .gte('lat', latMin)
      .lte('lat', latMax)
      .gte('lng', lngMin)
      .lte('lng', lngMax),
  ]);

  // Precise Haversine filter
  const headquarters = (hqRaw || []).filter(
    (hq) => haversine(lat, lng, hq.lat, hq.lng) <= RADIUS_METERS
  );

  const mines = (minesRaw || []).filter(
    (m) => haversine(lat, lng, m.lat, m.lng) <= RADIUS_METERS
  );

  return res.status(200).json({ headquarters, mines });
}
