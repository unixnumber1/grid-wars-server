#!/usr/bin/env node
// Test Overpass query for Nizhny Novgorod
(async () => {
  const { getCityBounds } = await import('../lib/geocity.js');
  const b = await getCityBounds('нижний_новгород_ru');
  if (!b) { console.log('No bounds found'); process.exit(1); }

  const [minLat, maxLat, minLng, maxLng] = b.boundingbox;
  console.log('Bounds:', b.boundingbox);
  console.log('Size:', ((maxLat - minLat) * 111).toFixed(1) + 'km x ' + ((maxLng - minLng) * 111 * Math.cos(minLat * Math.PI / 180)).toFixed(1) + 'km');

  const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;
  const query = `[out:json][timeout:30];(nwr["tourism"~"attraction|museum|gallery|viewpoint"]["name"](${bbox});nwr["historic"~"castle|fort|ruins|palace|manor|monument|memorial"]["name"](${bbox});nwr["amenity"~"theatre|arts_centre"]["name"](${bbox});nwr["leisure"="park"]["name"](${bbox}););out center 50;`;

  console.log('Querying Overpass...');
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(40000),
  });
  console.log('Status:', resp.status);
  const data = await resp.json();
  console.log('Elements:', data.elements?.length || 0);
  if (data.elements?.length) {
    data.elements.slice(0, 15).forEach(e => console.log(' ', e.tags?.name));
  }
  if (data.remark) console.log('Remark:', data.remark);
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
