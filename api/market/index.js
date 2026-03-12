import { supabase, getPlayerByTelegramId } from '../../lib/supabase.js';
import { haversine } from '../../lib/haversine.js';
import { addXp } from '../../lib/xp.js';
import { SMALL_RADIUS, getPlayerAttack } from '../../lib/formulas.js';

/* ── Constants ─────────────────────────────────────────────── */

const PAGE_SIZE = 20;
const MAX_ACTIVE_LISTINGS = 10;
const LISTING_TTL_HOURS = 48;
const COMMISSION = 0.10; // 10% market fee
const COURIER_KILL_XP = 50;

const COURIER_HP = 5000;
const COURIER_SPEED = 0.0015; // ~150 km/h stored in DB

async function notify(playerId, type, message, data = null) {
  try {
    await supabase.from('notifications').insert({ player_id: playerId, type, message, data });
  } catch (e) { console.error('[notify] error:', e.message); }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/* ── Action: listings (GET) ────────────────────────────────── */

async function handleListings(req, res) {
  const { telegram_id, sort = 'new', page = '0' } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const offset = Math.max(0, parseInt(page, 10) || 0) * PAGE_SIZE;
  const nowISO = new Date().toISOString();

  let query = supabase
    .from('market_listings')
    .select(`
      id, price_diamonds, is_private, private_code, created_at, expires_at,
      market_id,
      items!inner(id, type, rarity, name, emoji, stat_value, attack, crit_chance, defense),
      seller:players!market_listings_seller_id_fkey(id, username, game_username, avatar)
    `, { count: 'exact' })
    .eq('status', 'active')
    .gt('expires_at', nowISO);

  query = query.or(`is_private.eq.false,seller_id.eq.${player.id}`);

  if (sort === 'cheap') query = query.order('price_diamonds', { ascending: true });
  else if (sort === 'expensive') query = query.order('price_diamonds', { ascending: false });
  else query = query.order('created_at', { ascending: false });

  query = query.range(offset, offset + PAGE_SIZE - 1);

  const { data: listings, error, count } = await query;

  if (error) {
    console.error('[market/listings] error:', error);
    return res.status(500).json({ error: error.message });
  }

  const cleaned = (listings || []).map(l => {
    const out = { ...l };
    if (l.seller?.id !== player.id) delete out.private_code;
    return out;
  });

  return res.json({ listings: cleaned, total: count || 0 });
}

/* ── Action: my-listings (GET) ─────────────────────────────── */

async function handleMyListings(req, res) {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: listings, error } = await supabase
    .from('market_listings')
    .select(`
      id, price_diamonds, is_private, private_code, status, created_at, expires_at,
      market_id,
      items(id, type, rarity, name, emoji, stat_value, attack, crit_chance, defense)
    `)
    .eq('seller_id', player.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[market/my-listings] error:', error);
    return res.status(500).json({ error: error.message });
  }

  return res.json({ listings: listings || [] });
}

/* ── Action: list-item (POST) ──────────────────────────────── */

async function handleListItem(req, res) {
  const { telegram_id, item_id, price_diamonds, is_private, lat, lng } = req.body || {};
  if (!telegram_id || !item_id || !price_diamonds) {
    return res.status(400).json({ error: 'telegram_id, item_id, price_diamonds required' });
  }

  const price = parseInt(price_diamonds, 10);
  if (isNaN(price) || price < 1 || price > 100000) {
    return res.status(400).json({ error: 'Price must be 1-100000 diamonds' });
  }

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: item, error: iErr } = await supabase
    .from('items')
    .select('id, rarity, equipped, on_market, owner_id')
    .eq('id', item_id)
    .maybeSingle();

  if (iErr) return res.status(500).json({ error: iErr.message });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.owner_id !== player.id) return res.status(403).json({ error: 'Not your item' });
  if (item.equipped) return res.status(400).json({ error: 'Unequip item first' });
  if (item.on_market) return res.status(400).json({ error: 'Item already on market' });

  const { count } = await supabase
    .from('market_listings')
    .select('*', { count: 'exact', head: true })
    .eq('seller_id', player.id)
    .eq('status', 'active');

  if ((count || 0) >= MAX_ACTIVE_LISTINGS) {
    return res.status(400).json({ error: `Max ${MAX_ACTIVE_LISTINGS} active listings` });
  }

  const privateCode = is_private ? generateCode() : null;
  const expiresAt = new Date(Date.now() + LISTING_TTL_HOURS * 3600 * 1000).toISOString();

  let nearestMarket = null;
  if (lat != null && lng != null) {
    const pLat = parseFloat(lat), pLng = parseFloat(lng);
    if (!isNaN(pLat) && !isNaN(pLng)) {
      const { data: markets } = await supabase
        .from('markets')
        .select('id, lat, lng, name')
        .limit(50);

      if (markets && markets.length > 0) {
        let minDist = Infinity;
        for (const m of markets) {
          const d = haversine(pLat, pLng, m.lat, m.lng);
          if (d < minDist) { minDist = d; nearestMarket = m; }
        }
      }
    }
  }

  await supabase.from('items').update({ on_market: true }).eq('id', item_id);

  const listingRow = {
    item_id,
    seller_id: player.id,
    market_id: nearestMarket?.id || null,
    price_diamonds: price,
    is_private: !!is_private,
    private_code: privateCode,
    // pending until courier delivers to market; active immediately if no courier
    status: 'active',
    expires_at: expiresAt,
  };

  // Check if courier will be created
  let willHaveCourier = false;
  if (nearestMarket && lat != null && lng != null) {
    const pLat = parseFloat(lat), pLng = parseFloat(lng);
    if (!isNaN(pLat) && !isNaN(pLng) && haversine(pLat, pLng, nearestMarket.lat, nearestMarket.lng) > 200) {
      willHaveCourier = true;
      listingRow.status = 'pending';
    }
  }

  const { data: listing, error: lErr } = await supabase
    .from('market_listings')
    .insert(listingRow)
    .select('id')
    .single();

  if (lErr) {
    console.error('[market/list-item] insert error:', lErr);
    await supabase.from('items').update({ on_market: false }).eq('id', item_id);
    return res.status(500).json({ error: lErr.message });
  }

  let courierId = null;
  if (willHaveCourier) {
    const pLat = parseFloat(lat), pLng = parseFloat(lng);
    const { data: courier } = await supabase
      .from('couriers')
      .insert({
        listing_id: listing.id,
        item_id,
        owner_id: player.id,
        type: 'to_market',
        start_lat: pLat,
        start_lng: pLng,
        target_lat: nearestMarket.lat,
        target_lng: nearestMarket.lng,
        current_lat: pLat,
        current_lng: pLng,
        speed: COURIER_SPEED,
        hp: COURIER_HP,
        max_hp: COURIER_HP,
        status: 'moving',
      })
      .select('id')
      .single();
    if (courier) courierId = courier.id;
  }

  return res.json({
    success: true,
    listing_id: listing.id,
    courier_id: courierId,
    private_code: privateCode,
    nearest_market: nearestMarket ? { id: nearestMarket.id, name: nearestMarket.name, lat: nearestMarket.lat, lng: nearestMarket.lng } : null,
  });
}

/* ── Action: buy (POST) ────────────────────────────────────── */

async function handleBuy(req, res) {
  const { telegram_id, listing_id, private_code, lat, lng } = req.body || {};
  if (!telegram_id || !listing_id) {
    return res.status(400).json({ error: 'telegram_id and listing_id required' });
  }

  const { player: buyer, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id,diamonds');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!buyer) return res.status(404).json({ error: 'Player not found' });

  const { data: listing, error: lErr } = await supabase
    .from('market_listings')
    .select(`
      id, item_id, seller_id, price_diamonds, is_private, private_code, status, expires_at,
      items(id, rarity, owner_id),
      market_id,
      markets(lat, lng)
    `)
    .eq('id', listing_id)
    .maybeSingle();

  if (lErr) return res.status(500).json({ error: lErr.message });
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.status !== 'active') return res.status(400).json({ error: 'Listing not active' });
  if (new Date(listing.expires_at) < new Date()) return res.status(400).json({ error: 'Listing expired' });
  if (listing.seller_id === buyer.id) return res.status(400).json({ error: 'Cannot buy your own listing' });

  if (listing.is_private) {
    if (!private_code || private_code !== listing.private_code) {
      return res.status(403).json({ error: 'Invalid private code' });
    }
  }

  const price = listing.price_diamonds;
  if ((buyer.diamonds ?? 0) < price) {
    return res.status(400).json({ error: 'Not enough diamonds' });
  }

  const sellerPayout = Math.floor(price * (1 - COMMISSION));

  const { data: seller } = await supabase
    .from('players').select('diamonds').eq('id', listing.seller_id).single();

  const [
    { error: buyerErr },
    { error: sellerErr },
    { error: listingErr },
    { error: itemErr },
  ] = await Promise.all([
    supabase.from('players')
      .update({ diamonds: (buyer.diamonds ?? 0) - price })
      .eq('id', buyer.id),
    supabase.from('players')
      .update({ diamonds: (seller?.diamonds ?? 0) + sellerPayout })
      .eq('id', listing.seller_id),
    supabase.from('market_listings')
      .update({ status: 'sold', buyer_id: buyer.id })
      .eq('id', listing_id),
    supabase.from('items')
      .update({ owner_id: buyer.id, on_market: false })
      .eq('id', listing.item_id),
  ]);

  if (buyerErr || sellerErr || listingErr || itemErr) {
    console.error('[market/buy] errors:', { buyerErr, sellerErr, listingErr, itemErr });
    return res.status(500).json({ error: 'Transaction failed' });
  }

  // Notify seller about the sale
  notify(listing.seller_id, 'item_sold',
    `💰 Ваш предмет продан за ${price} 💎 (получено ${sellerPayout} 💎)`,
    { listing_id: listing.id, price, payout: sellerPayout });

  let courierId = null;
  const buyerLat = parseFloat(lat), buyerLng = parseFloat(lng);
  let marketLat = null;
  let marketLng = null;

  // Always find nearest market to BUYER (delivery starts from buyer's closest market)
  if (!isNaN(buyerLat) && !isNaN(buyerLng)) {
    const { data: allMarkets } = await supabase.from('markets').select('lat,lng').limit(100);
    if (allMarkets && allMarkets.length > 0) {
      let minDist = Infinity;
      for (const m of allMarkets) {
        const d = haversine(buyerLat, buyerLng, m.lat, m.lng);
        if (d < minDist) { minDist = d; marketLat = m.lat; marketLng = m.lng; }
      }
    }
  }

  if (!isNaN(buyerLat) && !isNaN(buyerLng) && marketLat && marketLng) {
    const { data: courier } = await supabase
      .from('couriers')
      .insert({
        listing_id: listing.id,
        item_id: listing.item_id,
        owner_id: buyer.id,
        type: 'delivery',
        start_lat: marketLat,
        start_lng: marketLng,
        target_lat: buyerLat,
        target_lng: buyerLng,
        current_lat: marketLat,
        current_lng: marketLng,
        speed: COURIER_SPEED,
        hp: COURIER_HP,
        max_hp: COURIER_HP,
        status: 'moving',
      })
      .select('id')
      .single();
    if (courier) courierId = courier.id;
  }

  return res.json({
    success: true,
    courier_id: courierId,
    price_paid: price,
    seller_received: sellerPayout,
    market_location: marketLat ? { lat: marketLat, lng: marketLng } : null,
  });
}

/* ── Action: cancel (POST) ─────────────────────────────────── */

async function handleCancel(req, res) {
  const { telegram_id, listing_id } = req.body || {};
  if (!telegram_id || !listing_id) {
    return res.status(400).json({ error: 'telegram_id and listing_id required' });
  }

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: listing, error: lErr } = await supabase
    .from('market_listings')
    .select('id, item_id, seller_id, status')
    .eq('id', listing_id)
    .maybeSingle();

  if (lErr) return res.status(500).json({ error: lErr.message });
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.seller_id !== player.id) return res.status(403).json({ error: 'Not your listing' });
  if (listing.status !== 'active' && listing.status !== 'pending') return res.status(400).json({ error: 'Listing not active' });

  await Promise.all([
    supabase.from('market_listings')
      .update({ status: 'cancelled' })
      .eq('id', listing_id),
    supabase.from('items')
      .update({ on_market: false })
      .eq('id', listing.item_id),
    supabase.from('couriers')
      .update({ status: 'cancelled' })
      .eq('listing_id', listing_id)
      .eq('status', 'moving'),
  ]);

  return res.json({ success: true });
}

/* ── Action: attack-courier (POST) ─────────────────────────── */

async function handleAttackCourier(req, res) {
  const { telegram_id, courier_id, lat, lng } = req.body || {};
  if (!telegram_id || !courier_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'telegram_id, courier_id, lat, lng required' });
  }

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  if (isNaN(pLat) || isNaN(pLng)) return res.status(400).json({ error: 'Invalid coordinates' });

  const { player, error: pErr } = await getPlayerByTelegramId(
    telegram_id, 'id,level,bonus_attack,bonus_crit'
  );
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: courier, error: cErr } = await supabase
    .from('couriers')
    .select('id, owner_id, listing_id, item_id, current_lat, current_lng, hp, max_hp, status')
    .eq('id', courier_id)
    .maybeSingle();

  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!courier) return res.status(404).json({ error: 'Courier not found' });
  if (courier.status !== 'moving') return res.status(400).json({ error: 'Courier not moving' });
  if (courier.owner_id === player.id) return res.status(400).json({ error: 'Cannot attack your own courier' });

  const dist = haversine(pLat, pLng, courier.current_lat, courier.current_lng);
  if (dist > SMALL_RADIUS) {
    return res.status(400).json({ error: 'Too far from courier', distance: Math.round(dist) });
  }

  const baseAttack = getPlayerAttack(player.level ?? 1);
  const weaponAttack = player.bonus_attack ?? 0;
  const critChance = 0.20 + ((player.bonus_crit ?? 0) / 100);
  const isCrit = Math.random() < critChance;
  let damage = baseAttack + weaponAttack;
  if (isCrit) damage *= 2;
  damage = Math.round(damage);

  const newHp = Math.max(0, courier.hp - damage);
  const killed = newHp <= 0;

  if (killed) {
    const { data: drop } = await supabase
      .from('courier_drops')
      .insert({
        courier_id: courier.id,
        item_id: courier.item_id,
        listing_id: courier.listing_id,
        lat: courier.current_lat,
        lng: courier.current_lng,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    await supabase.from('couriers')
      .update({ status: 'killed', hp: 0 })
      .eq('id', courier_id);

    // Notify courier owner
    notify(courier.owner_id, 'courier_killed',
      '💥 Ваш курьер был уничтожен! Предмет выпал на карту.',
      { courier_id: courier.id, listing_id: courier.listing_id });

    const xpResult = await addXp(player.id, COURIER_KILL_XP);

    return res.json({
      success: true,
      killed: true,
      damage,
      isCrit,
      drop_id: drop?.id,
      drop_location: { lat: courier.current_lat, lng: courier.current_lng },
      xp: xpResult,
    });
  }

  await supabase.from('couriers')
    .update({ hp: newHp })
    .eq('id', courier_id);

  return res.json({
    success: true,
    killed: false,
    damage,
    isCrit,
    courierHp: newHp,
    courierMaxHp: courier.max_hp,
  });
}

/* ── Action: pickup-drop (POST) ────────────────────────────── */

async function handlePickupDrop(req, res) {
  const { telegram_id, drop_id, lat, lng } = req.body || {};
  if (!telegram_id || !drop_id || lat == null || lng == null) {
    return res.status(400).json({ error: 'telegram_id, drop_id, lat, lng required' });
  }

  const pLat = parseFloat(lat), pLng = parseFloat(lng);
  if (isNaN(pLat) || isNaN(pLng)) return res.status(400).json({ error: 'Invalid coordinates' });

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: drop, error: dErr } = await supabase
    .from('courier_drops')
    .select(`
      id, item_id, listing_id, lat, lng, picked_up, expires_at,
      couriers!courier_drops_courier_id_fkey(type, owner_id, listing_id)
    `)
    .eq('id', drop_id)
    .maybeSingle();

  if (dErr) return res.status(500).json({ error: dErr.message });
  if (!drop) return res.status(404).json({ error: 'Drop not found' });
  if (drop.picked_up) return res.status(400).json({ error: 'Already picked up' });
  if (new Date(drop.expires_at) < new Date()) return res.status(400).json({ error: 'Drop expired' });

  const dist = haversine(pLat, pLng, drop.lat, drop.lng);
  if (dist > SMALL_RADIUS) {
    return res.status(400).json({ error: 'Too far from drop', distance: Math.round(dist) });
  }

  await Promise.all([
    supabase.from('items')
      .update({ owner_id: player.id, on_market: false })
      .eq('id', drop.item_id),
    supabase.from('courier_drops')
      .update({ picked_up: true, picked_by: player.id })
      .eq('id', drop_id),
  ]);

  let message = 'Item picked up!';
  if (drop.couriers?.type === 'delivery' && drop.listing_id) {
    const { data: listing } = await supabase
      .from('market_listings')
      .select('id, buyer_id, price_diamonds, seller_id, item_id')
      .eq('id', drop.listing_id)
      .maybeSingle();

    if (listing && listing.buyer_id) {
      const { data: buyerPlayer } = await supabase
        .from('players').select('diamonds').eq('id', listing.buyer_id).single();
      if (buyerPlayer) {
        await supabase.from('players')
          .update({ diamonds: (buyerPlayer.diamonds ?? 0) + listing.price_diamonds })
          .eq('id', listing.buyer_id);
      }

      await supabase.from('market_listings')
        .update({ status: 'intercepted' })
        .eq('id', listing.id);

      message = 'Courier intercepted! Item stolen, buyer refunded.';
    }
  }

  const { data: item } = await supabase
    .from('items')
    .select('id, type, rarity, name, emoji, attack, crit_chance, defense')
    .eq('id', drop.item_id)
    .maybeSingle();

  return res.json({ success: true, item, message });
}

/* ── Action: move-couriers (POST) ──────────────────────────── */

async function handleMoveCouriers(req, res) {
  const nowISO = new Date().toISOString();

  // ── 1. Move active couriers ────────────────────────────────
  const { data: couriers, error } = await supabase
    .from('couriers')
    .select('id, start_lat, start_lng, current_lat, current_lng, target_lat, target_lng, speed, status, created_at')
    .eq('status', 'moving');

  if (error) {
    console.error('[market/move-couriers] error:', error);
    return res.status(500).json({ error: error.message });
  }

  // Time-based: compute position from elapsed time since creation
  // 150 km/h ≈ 0.000375 deg/sec
  const SPEED_DEG_PER_SEC = 0.000375;
  const now = Date.now();
  const updates = [];
  const arrived = [];

  for (const c of (couriers || [])) {
    const routeLat = c.target_lat - c.start_lat;
    const routeLng = c.target_lng - c.start_lng;
    const routeDist = Math.sqrt(routeLat * routeLat + routeLng * routeLng);

    if (routeDist < 0.0001) {
      arrived.push(c.id);
      continue;
    }

    const elapsedSec = (now - new Date(c.created_at).getTime()) / 1000;
    const traveled = SPEED_DEG_PER_SEC * elapsedSec;
    const progress = Math.min(traveled / routeDist, 1.0);

    if (progress >= 0.99) {
      arrived.push(c.id);
      continue;
    }

    const newLat = c.start_lat + routeLat * progress;
    const newLng = c.start_lng + routeLng * progress;
    updates.push({ id: c.id, current_lat: newLat, current_lng: newLng });
  }

  const updatePromises = updates.map(u =>
    supabase.from('couriers')
      .update({ current_lat: u.current_lat, current_lng: u.current_lng })
      .eq('id', u.id)
  );

  if (arrived.length > 0) {
    updatePromises.push(
      supabase.from('couriers')
        .update({ status: 'delivered' })
        .in('id', arrived)
    );
  }

  if (updatePromises.length > 0) await Promise.all(updatePromises);

  // Handle delivered couriers: activate pending listings (to_market), notify (delivery)
  if (arrived.length > 0) {
    try {
      const { data: deliveredCouriers } = await supabase
        .from('couriers')
        .select('id, owner_id, type, listing_id')
        .in('id', arrived);
      for (const dc of (deliveredCouriers || [])) {
        if (dc.type === 'to_market' && dc.listing_id) {
          // Courier arrived at market → activate the listing
          await supabase.from('market_listings')
            .update({ status: 'active' })
            .eq('id', dc.listing_id)
            .eq('status', 'pending');
          notify(dc.owner_id, 'item_delivered', '🎪 Курьер доставил товар на рынок!', { listing_id: dc.listing_id });
        } else if (dc.type === 'delivery') {
          notify(dc.owner_id, 'item_delivered', '📦 Курьер доставил ваш предмет!', { courier_id: dc.id });
        }
      }
    } catch (e) { /* silent */ }
  }

  // ── 2. Expire old drops → return items to owners ───────────
  try {
    const { data: expiredDrops } = await supabase
      .from('courier_drops')
      .select('id, item_id, courier_id, listing_id')
      .eq('picked_up', false)
      .lt('expires_at', nowISO)
      .limit(50);

    if (expiredDrops && expiredDrops.length > 0) {
      for (const drop of expiredDrops) {
        // Return item to original owner (on_market = false)
        await supabase.from('items')
          .update({ on_market: false })
          .eq('id', drop.item_id);
        // Mark drop as picked up so it won't be processed again
        await supabase.from('courier_drops')
          .update({ picked_up: true })
          .eq('id', drop.id);
        // If linked to a listing, cancel it
        if (drop.listing_id) {
          const { data: listing } = await supabase
            .from('market_listings')
            .select('id, buyer_id, price_diamonds, status')
            .eq('id', drop.listing_id)
            .maybeSingle();
          if (listing && listing.status === 'intercepted' && listing.buyer_id) {
            // Refund buyer
            const { data: buyer } = await supabase
              .from('players').select('id, diamonds').eq('id', listing.buyer_id).maybeSingle();
            if (buyer) {
              await supabase.from('players')
                .update({ diamonds: (buyer.diamonds ?? 0) + listing.price_diamonds })
                .eq('id', buyer.id);
            }
          }
        }
      }
      console.log(`[move-couriers] expired ${expiredDrops.length} drops, items returned`);
    }
  } catch (e) {
    console.error('[move-couriers] drop expiration error:', e.message);
  }

  // ── 3. Expire old listings (past expires_at) ───────────────
  try {
    const { data: expiredListings } = await supabase
      .from('market_listings')
      .select('id, item_id, seller_id')
      .eq('status', 'active')
      .lt('expires_at', nowISO)
      .limit(50);

    if (expiredListings && expiredListings.length > 0) {
      for (const listing of expiredListings) {
        await Promise.all([
          supabase.from('market_listings')
            .update({ status: 'expired' })
            .eq('id', listing.id),
          supabase.from('items')
            .update({ on_market: false })
            .eq('id', listing.item_id),
        ]);
        // Kill any active courier for this listing
        await supabase.from('couriers')
          .update({ status: 'cancelled' })
          .eq('listing_id', listing.id)
          .eq('status', 'moving');
      }
      console.log(`[move-couriers] expired ${expiredListings.length} listings`);
    }
  } catch (e) {
    console.error('[move-couriers] listing expiration error:', e.message);
  }

  // ── 4. Return remaining moving couriers ────────────────────
  const { data: allCouriers } = await supabase
    .from('couriers')
    .select('id, type, owner_id, current_lat, current_lng, target_lat, target_lng, hp, max_hp, status, listing_id')
    .eq('status', 'moving');

  return res.json({
    moved: updates.length,
    delivered: arrived.length,
    couriers: allCouriers || [],
  });
}

/* ── Main router ───────────────────────────────────────────── */

export default async function handler(req, res) {
  // GET actions: read from query string
  if (req.method === 'GET') {
    const { action } = req.query;
    if (action === 'listings')    return handleListings(req, res);
    if (action === 'my-listings') return handleMyListings(req, res);
    return res.status(400).json({ error: 'Unknown GET action' });
  }

  // POST actions: read from body
  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'list-item')       return handleListItem(req, res);
    if (action === 'buy')             return handleBuy(req, res);
    if (action === 'cancel')          return handleCancel(req, res);
    if (action === 'attack-courier')  return handleAttackCourier(req, res);
    if (action === 'pickup-drop')     return handlePickupDrop(req, res);
    if (action === 'move-couriers')   return handleMoveCouriers(req, res);
    return res.status(400).json({ error: 'Unknown POST action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
