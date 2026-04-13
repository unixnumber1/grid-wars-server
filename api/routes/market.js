import { Router } from 'express';
import { supabase, getPlayerByTelegramId, sendTelegramNotification, buildAttackButton } from '../../lib/supabase.js';
import { log } from '../../lib/log.js';
import { haversine, findSafeDropPosition } from '../../lib/haversine.js';
import { addXp } from '../../lib/xp.js';
import { SMALL_RADIUS, LARGE_RADIUS, getPlayerAttack } from '../../lib/formulas.js';
import { gameState } from '../../lib/gameState.js';
import { getPlayerSkillEffects } from '../../config/skills.js';
import { withPlayerLock } from '../../lib/playerLock.js';

export const marketRouter = Router();

/* ── Constants ─────────────────────────────────────────────── */

const PAGE_SIZE = 20;
const MAX_ACTIVE_LISTINGS = 10;
const LISTING_TTL_HOURS = 48;
const COMMISSION = 0.10; // 10% market fee
const COURIER_KILL_XP = 50;

const COURIER_HP = 5000;
const COURIER_SPEED_SELLER   = 0.0002;  // 🚶 ~20 km/h (to_market)
const COURIER_SPEED_DELIVERY = 0.0015;  // 🚚 ~150 km/h (delivery)

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

// Validate client-supplied private code (6 chars, valid charset)
function validateCode(code) {
  if (!code || typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length !== 6) return null;
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(trimmed)) return null;
  return trimmed;
}

/* ── Action: listings (GET) ────────────────────────────────── */

async function handleListings(req, res) {
  const { telegram_id, sort = 'new', page = '0', item_type } = req.query;
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
      market_id, item_type, core_id,
      items(id, type, rarity, name, emoji, stat_value, attack, crit_chance, defense, upgrade_level, block_chance, plus),
      seller:players!market_listings_seller_id_fkey(id, username, game_username, avatar)
    `, { count: 'exact' })
    .eq('status', 'active')
    .gt('expires_at', nowISO);

  if (item_type === 'core') query = query.eq('item_type', 'core');
  else if (item_type === 'item') query = query.or(`item_type.is.null,item_type.neq.core`);

  // Private listings visible to all (code required on buy, hidden from response)

  if (sort === 'cheap') query = query.order('price_diamonds', { ascending: true });
  else if (sort === 'expensive') query = query.order('price_diamonds', { ascending: false });
  else query = query.order('created_at', { ascending: false });

  query = query.range(offset, offset + PAGE_SIZE - 1);

  const { data: listings, error, count } = await query;

  if (error) {
    console.error('[market/listings] error:', error);
    return res.status(500).json({ error: error.message });
  }

  // Enrich core listings with core info from gameState
  const cleaned = (listings || []).map(l => {
    const out = { ...l };
    if (l.seller?.id !== player.id) delete out.private_code;
    if (l.item_type === 'core' && l.core_id && gameState.loaded) {
      const core = gameState.cores.get(l.core_id);
      if (core) out.core_info = { core_type: core.core_type, level: core.level };
    }
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
      market_id, item_type, core_id,
      items(id, type, rarity, name, emoji, stat_value, attack, crit_chance, defense, upgrade_level, block_chance, plus)
    `)
    .eq('seller_id', player.id)
    .in('status', ['active', 'pending'])
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[market/my-listings] error:', error);
    return res.status(500).json({ error: error.message });
  }

  // Enrich core listings
  const enriched = (listings || []).map(l => {
    if (l.item_type === 'core' && l.core_id && gameState.loaded) {
      const core = gameState.cores.get(l.core_id);
      if (core) l.core_info = { core_type: core.core_type, level: core.level };
    }
    return l;
  });

  return res.json({ listings: enriched });
}

/* ── Action: list-item (POST) ──────────────────────────────── */

async function handleListItem(req, res) {
  const { telegram_id, item_id, core_id, price_diamonds, is_private, private_code: clientCode, lat, lng } = req.body || {};
  if (!telegram_id || (!item_id && !core_id) || !price_diamonds) {
    return res.status(400).json({ error: 'telegram_id, item_id or core_id, price_diamonds required' });
  }

  const price = parseInt(price_diamonds, 10);
  if (isNaN(price) || price < 10 || price > 100000) {
    return res.status(400).json({ error: 'Price must be 10-100000 diamonds' });
  }

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { count } = await supabase
    .from('market_listings')
    .select('*', { count: 'exact', head: true })
    .eq('seller_id', player.id)
    .in('status', ['active', 'pending']);

  if ((count || 0) >= MAX_ACTIVE_LISTINGS) {
    return res.status(400).json({ error: `Max ${MAX_ACTIVE_LISTINGS} active listings` });
  }

  // ── Core listing (same flow as items — courier to market) ──
  if (core_id) {
    const core = gameState.loaded ? gameState.cores.get(core_id) : null;
    if (!core) {
      const { data: dbCore } = await supabase.from('cores').select('*').eq('id', core_id).maybeSingle();
      if (!dbCore) return res.status(404).json({ error: 'Core not found' });
      if (Number(dbCore.owner_id) !== Number(telegram_id)) return res.status(403).json({ error: 'Not your core' });
      if (dbCore.mine_cell_id) return res.status(400).json({ error: 'Core is installed in a mine' });
      if (dbCore.on_market) return res.status(400).json({ error: 'Core already on market' });
    } else {
      if (Number(core.owner_id) !== Number(telegram_id)) return res.status(403).json({ error: 'Not your core' });
      if (core.mine_cell_id) return res.status(400).json({ error: 'Core is installed in a mine' });
      if (core.on_market) return res.status(400).json({ error: 'Core already on market' });
    }

    const { data: coreLocked } = await supabase.from('cores')
      .update({ on_market: true })
      .eq('id', core_id).eq('on_market', false)
      .select('id').maybeSingle();
    if (!coreLocked) return res.status(409).json({ error: 'Core already on market' });
    if (gameState.loaded) {
      const gc = core || gameState.cores.get(core_id);
      if (gc) { gc.on_market = true; gameState.markDirty('cores', core_id); }
    }

    const privateCode = is_private ? (validateCode(clientCode) || generateCode()) : null;
    const expiresAt = new Date(Date.now() + LISTING_TTL_HOURS * 3600 * 1000).toISOString();

    let nearestMarket = null;
    if (lat != null && lng != null) {
      const pLat = parseFloat(lat), pLng = parseFloat(lng);
      if (!isNaN(pLat) && !isNaN(pLng)) {
        const markets = gameState.getAllMarkets();
        if (markets.length > 0) {
          let minDist = Infinity;
          for (const m of markets) {
            const d = haversine(pLat, pLng, m.lat, m.lng);
            if (d < minDist) { minDist = d; nearestMarket = m; }
          }
        }
      }
    }

    const listingRow = {
      seller_id: player.id,
      item_type: 'core',
      core_id,
      item_id: null,
      market_id: nearestMarket?.id || null,
      price_diamonds: price,
      is_private: !!is_private,
      private_code: privateCode,
      status: 'active',
      expires_at: expiresAt,
    };

    let willHaveCourier = false;
    if (nearestMarket && lat != null && lng != null) {
      const pLat = parseFloat(lat), pLng = parseFloat(lng);
      if (!isNaN(pLat) && !isNaN(pLng) && haversine(pLat, pLng, nearestMarket.lat, nearestMarket.lng) > 200) {
        willHaveCourier = true;
        listingRow.status = 'pending';
      }
    }

    const { data: listing, error: lErr } = await supabase.from('market_listings').insert(listingRow).select('id').single();
    if (lErr) {
      await supabase.from('cores').update({ on_market: false }).eq('id', core_id);
      return res.status(500).json({ error: lErr.message });
    }

    let courierId = null;
    if (willHaveCourier) {
      const pLat = parseFloat(lat), pLng = parseFloat(lng);
      const courierNow = new Date().toISOString();
      const { data: courier, error: cInsErr } = await supabase
        .from('couriers')
        .insert({
          listing_id: listing.id,
          owner_id: player.id,
          type: 'to_market',
          start_lat: pLat, start_lng: pLng,
          target_lat: nearestMarket.lat, target_lng: nearestMarket.lng,
          current_lat: pLat, current_lng: pLng,
          speed: COURIER_SPEED_SELLER,
          hp: COURIER_HP, max_hp: COURIER_HP,
          status: 'moving',
          to_market_id: nearestMarket.id,
          created_at: courierNow,
        })
        .select('id').single();
      if (cInsErr) console.error('[market/list-core] courier insert error:', cInsErr.message);
      if (courier) {
        courierId = courier.id;
        if (gameState.loaded) {
          gameState.upsertCourier({
            id: courier.id, listing_id: listing.id, owner_id: player.id,
            _core_id: core_id,
            type: 'to_market', start_lat: pLat, start_lng: pLng,
            target_lat: nearestMarket.lat, target_lng: nearestMarket.lng,
            current_lat: pLat, current_lng: pLng,
            speed: COURIER_SPEED_SELLER, hp: COURIER_HP, max_hp: COURIER_HP,
            status: 'moving', to_market_id: nearestMarket.id,
            created_at: new Date().toISOString(),
          });
        }
      }
    }

    if (gameState.loaded) gameState.upsertListing({ ...listingRow, id: listing.id });

    return res.json({
      success: true,
      listing_id: listing.id,
      courier_id: courierId,
      private_code: privateCode,
      nearest_market: nearestMarket ? { id: nearestMarket.id, name: nearestMarket.name, lat: nearestMarket.lat, lng: nearestMarket.lng } : null,
    });
  }

  // ── Item listing ──
  const { data: item, error: iErr } = await supabase
    .from('items')
    .select('id, rarity, equipped, on_market, owner_id, held_by_courier')
    .eq('id', item_id)
    .maybeSingle();

  if (iErr) return res.status(500).json({ error: iErr.message });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.owner_id !== player.id) return res.status(403).json({ error: 'Not your item' });
  if (item.equipped) return res.status(400).json({ error: 'Unequip item first' });
  if (item.on_market) return res.status(400).json({ error: 'Item already on market' });
  if (item.held_by_courier) return res.status(400).json({ error: 'Item in transit' });

  const privateCode = is_private ? (validateCode(clientCode) || generateCode()) : null;
  const expiresAt = new Date(Date.now() + LISTING_TTL_HOURS * 3600 * 1000).toISOString();

  let nearestMarket = null;
  if (lat != null && lng != null) {
    const pLat = parseFloat(lat), pLng = parseFloat(lng);
    if (!isNaN(pLat) && !isNaN(pLng)) {
      const markets = gameState.getAllMarkets();
      if (markets.length > 0) {
        let minDist = Infinity;
        for (const m of markets) {
          const d = haversine(pLat, pLng, m.lat, m.lng);
          if (d < minDist) { minDist = d; nearestMarket = m; }
        }
      }
    }
  }

  // Atomic lock: only proceed if item is not already on market
  const { data: itemLocked } = await supabase.from('items')
    .update({ on_market: true, equipped: false })
    .eq('id', item_id).eq('on_market', false)
    .select('id').maybeSingle();
  if (!itemLocked) return res.status(409).json({ error: 'Item already on market' });
  if (gameState.loaded) {
    const gi = gameState.getItemById(item_id);
    if (gi) { gi.on_market = true; gi.equipped = false; gameState.markDirty('items', gi.id); }
  }

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
    const itemCourierNow = new Date().toISOString();
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
        speed: COURIER_SPEED_SELLER,
        hp: COURIER_HP,
        max_hp: COURIER_HP,
        status: 'moving',
        to_market_id: nearestMarket.id,
        created_at: itemCourierNow,
      })
      .select('id')
      .single();
    if (courier) {
      courierId = courier.id;
      // Add courier to gameState so gameLoop can move it
      if (gameState.loaded) {
        gameState.upsertCourier({
          id: courier.id, listing_id: listing.id, item_id, owner_id: player.id,
          type: 'to_market', start_lat: pLat, start_lng: pLng,
          target_lat: nearestMarket.lat, target_lng: nearestMarket.lng,
          current_lat: pLat, current_lng: pLng,
          speed: COURIER_SPEED_SELLER, hp: COURIER_HP, max_hp: COURIER_HP,
          status: 'moving', to_market_id: nearestMarket.id,
          created_at: new Date().toISOString(),
        });
      }
      // Item is now held by courier
      await supabase.from('items').update({ held_by_courier: courier.id, held_by_market: null }).eq('id', item_id);
    }
  } else if (nearestMarket) {
    // No courier needed — item goes directly to market
    await supabase.from('items').update({ held_by_courier: null, held_by_market: nearestMarket.id }).eq('id', item_id);
  }

  // Update gameState with listing and courier
  if (gameState.loaded) {
    const fullListing = { ...listingRow, id: listing.id };
    gameState.upsertListing(fullListing);
  }

  return res.json({
    success: true,
    listing_id: listing.id,
    courier_id: courierId,
    private_code: privateCode,
    nearest_market: nearestMarket ? { id: nearestMarket.id, name: nearestMarket.name, lat: nearestMarket.lat, lng: nearestMarket.lng } : null,
  });
}

/* ── Helper: credit seller diamonds under their per-player lock ──
 *
 * Why: the market router holds a lock on the BUYER's telegram_id, but the
 * seller is a different player who can be running their own routes
 * concurrently (daily claim, vase break, monument loot, clan donate, etc.).
 * Many of those routes follow a `read snapshot → await → write back full
 * value` pattern, so a parallel buy crediting the seller via
 * `sp.diamonds += payout` could be silently overwritten by the seller's
 * own snapshot write a moment later. That's how 12 sellers lost ~673 💎
 * total before this fix.
 *
 * Holding the seller's lock makes the credit interleave correctly with
 * any of their own resource handlers. We re-read sp.diamonds INSIDE the
 * lock to avoid stale snapshots, then both gameState and DB are updated
 * inside the same critical section.
 */
async function creditSeller(sellerPlayerId, payout) {
  if (!sellerPlayerId || !payout || payout <= 0) return;
  // gameState is the source of truth — derive seller's tg id from there if possible.
  const spPre = gameState.loaded ? gameState.getPlayerById(sellerPlayerId) : null;
  const sellerTgId = spPre?.telegram_id;
  if (!sellerTgId) {
    // Fallback: no gameState entry — write straight to DB and skip the lock.
    const { data: fresh } = await supabase.from('players').select('diamonds').eq('id', sellerPlayerId).single();
    await supabase.from('players')
      .update({ diamonds: (fresh?.diamonds ?? 0) + payout })
      .eq('id', sellerPlayerId);
    return;
  }
  await withPlayerLock(sellerTgId, async () => {
    const sp = gameState.getPlayerById(sellerPlayerId);
    if (!sp) return;
    sp.diamonds = (sp.diamonds ?? 0) + payout;
    gameState.markDirty('players', sp.id);
    // Persist immediately — currency mutation is a critical op (Iron Rule #11).
    await supabase.from('players').update({ diamonds: sp.diamonds }).eq('id', sellerPlayerId);
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
      item_type, core_id,
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

  // Optimistic lock: listing must still be active
  const { data: listingLocked, error: listingErr } = await supabase.from('market_listings')
    .update({ status: 'sold', buyer_id: buyer.id })
    .eq('id', listing_id).eq('status', 'active')
    .select('id').maybeSingle();
  if (!listingLocked) return res.status(409).json({ error: 'Listing already sold or changed' });

  // Optimistic lock: buyer must still have enough diamonds
  const { data: buyerLocked, error: buyerErr } = await supabase.from('players')
    .update({ diamonds: (buyer.diamonds ?? 0) - price })
    .eq('id', buyer.id).eq('diamonds', buyer.diamonds ?? 0)
    .select('id').maybeSingle();
  if (!buyerLocked) {
    await supabase.from('market_listings').update({ status: 'active', buyer_id: null }).eq('id', listing_id);
    return res.status(409).json({ error: 'Конфликт — попробуйте снова' });
  }

  // ── Core purchase: courier delivery (same as items) ──
  if (listing.item_type === 'core' && listing.core_id) {
    // Buyer is already inside withPlayerLock(buyer_telegram_id) at the router level.
    // Update buyer + listing now (lock already held), then take the seller's lock to
    // credit them safely against any concurrent snapshot+overwrite from their own routes.
    if (gameState.loaded) {
      const bl = gameState.getListingById(listing_id);
      if (bl) { bl.status = 'sold'; bl.buyer_id = buyer.id; gameState.markDirty('marketListings', bl.id); }
      const bp = gameState.getPlayerById(buyer.id);
      if (bp) { bp.diamonds = (buyer.diamonds ?? 0) - price; gameState.markDirty('players', bp.id); }
    }
    await creditSeller(listing.seller_id, sellerPayout);

    notify(listing.seller_id, 'core_sold',
      `💰 Ваше ядро продано за ${price} 💎 (получено ${sellerPayout} 💎)`,
      { listing_id: listing.id, price, payout: sellerPayout });

    // Determine buyer position for delivery
    const reqLat = lat != null ? parseFloat(lat) : NaN;
    const reqLng = lng != null ? parseFloat(lng) : NaN;
    let bLat, bLng;
    if (!isNaN(reqLat) && !isNaN(reqLng)) {
      bLat = reqLat; bLng = reqLng;
    } else {
      const { data: buyerPos } = await supabase
        .from('players').select('last_lat, last_lng').eq('id', buyer.id).single();
      bLat = buyerPos?.last_lat; bLng = buyerPos?.last_lng;
    }

    // Find nearest market for courier start
    let marketLat = null, marketLng = null;
    if (bLat != null && bLng != null) {
      const allMarkets = gameState.getAllMarkets();
      if (allMarkets.length) {
        let minDist = Infinity;
        for (const m of allMarkets) {
          const d = haversine(bLat, bLng, m.lat, m.lng);
          if (d < minDist) { minDist = d; marketLat = m.lat; marketLng = m.lng; }
        }
      }
    }

    const distToMarket = (bLat != null && marketLat != null) ? haversine(bLat, bLng, marketLat, marketLng) : Infinity;
    const directTransfer = distToMarket <= SMALL_RADIUS;

    let courierId = null;
    if (directTransfer) {
      // Near market — instant transfer
      await supabase.from('cores')
        .update({ owner_id: Number(telegram_id), on_market: false, mine_cell_id: null, slot_index: null })
        .eq('id', listing.core_id);
      if (gameState.loaded) {
        const core = gameState.cores.get(listing.core_id);
        if (core) { core.owner_id = Number(telegram_id); core.on_market = false; core.mine_cell_id = null; core.slot_index = null; gameState.markDirty('cores', core.id); }
      }
    } else if (bLat != null && bLng != null && marketLat && marketLng) {
      // Delivery courier
      const deliveryCourierNow = new Date().toISOString();
      const { data: courier, error: cdErr } = await supabase
        .from('couriers')
        .insert({
          listing_id: listing.id,
          owner_id: buyer.id,
          type: 'delivery',
          start_lat: marketLat, start_lng: marketLng,
          target_lat: bLat, target_lng: bLng,
          current_lat: marketLat, current_lng: marketLng,
          speed: COURIER_SPEED_DELIVERY,
          hp: COURIER_HP, max_hp: COURIER_HP,
          status: 'moving',
          created_at: deliveryCourierNow,
        })
        .select('id').single();
      if (cdErr) console.error('[market/buy-core] courier insert error:', cdErr.message);
      if (courier) {
        courierId = courier.id;
        if (gameState.loaded) {
          gameState.upsertCourier({
            id: courier.id, listing_id: listing.id, _core_id: listing.core_id, owner_id: buyer.id,
            type: 'delivery', start_lat: marketLat, start_lng: marketLng,
            target_lat: bLat, target_lng: bLng,
            current_lat: marketLat, current_lng: marketLng,
            speed: COURIER_SPEED_DELIVERY, hp: COURIER_HP, max_hp: COURIER_HP,
            status: 'moving', created_at: new Date().toISOString(),
          });
        }
      } else {
        // Courier creation failed — direct transfer fallback
        await supabase.from('cores')
          .update({ owner_id: Number(telegram_id), on_market: false, mine_cell_id: null, slot_index: null })
          .eq('id', listing.core_id);
        if (gameState.loaded) {
          const core = gameState.cores.get(listing.core_id);
          if (core) { core.owner_id = Number(telegram_id); core.on_market = false; core.mine_cell_id = null; core.slot_index = null; gameState.markDirty('cores', core.id); }
        }
      }
    } else {
      // No position — direct transfer
      await supabase.from('cores')
        .update({ owner_id: Number(telegram_id), on_market: false, mine_cell_id: null, slot_index: null })
        .eq('id', listing.core_id);
      if (gameState.loaded) {
        const core = gameState.cores.get(listing.core_id);
        if (core) { core.owner_id = Number(telegram_id); core.on_market = false; core.mine_cell_id = null; core.slot_index = null; gameState.markDirty('cores', core.id); }
      }
    }

    return res.json({
      success: true, price_paid: price, seller_received: sellerPayout,
      courier_id: courierId,
      market_location: marketLat ? { lat: marketLat, lng: marketLng } : null,
    });
  }

  // ── Item purchase ──

  // 1. Update buyer + listing now (we already hold buyer_telegram_id lock).
  if (gameState.loaded) {
    const bl = gameState.getListingById(listing_id);
    if (bl) { bl.status = 'sold'; bl.buyer_id = buyer.id; gameState.markDirty('marketListings', bl.id); }
    const bp = gameState.getPlayerById(buyer.id);
    if (bp) { bp.diamonds = (buyer.diamonds ?? 0) - price; gameState.markDirty('players', bp.id); }
  }

  // 2. Credit seller under their own lock — see creditSeller for the why.
  await creditSeller(listing.seller_id, sellerPayout);

  notify(listing.seller_id, 'item_sold',
    `💰 Ваш предмет продан за ${price} 💎 (получено ${sellerPayout} 💎)`,
    { listing_id: listing.id, price, payout: sellerPayout });

  // 3. Determine delivery method BEFORE transferring item ownership
  let courierId = null;
  const reqLat = lat != null ? parseFloat(lat) : NaN;
  const reqLng = lng != null ? parseFloat(lng) : NaN;
  let bLat, bLng;
  if (!isNaN(reqLat) && !isNaN(reqLng)) {
    bLat = reqLat;
    bLng = reqLng;
  } else {
    const { data: buyerPos } = await supabase
      .from('players').select('last_lat, last_lng').eq('id', buyer.id).single();
    bLat = buyerPos?.last_lat;
    bLng = buyerPos?.last_lng;
  }

  let marketLat = null, marketLng = null;
  if (bLat != null && bLng != null) {
    const allMarkets = gameState.getAllMarkets();
    if (allMarkets.length > 0) {
      let minDist = Infinity;
      for (const m of allMarkets) {
        const d = haversine(bLat, bLng, m.lat, m.lng);
        if (d < minDist) { minDist = d; marketLat = m.lat; marketLng = m.lng; }
      }
    }
  }

  const distToMarket = (bLat != null && marketLat != null) ? haversine(bLat, bLng, marketLat, marketLng) : Infinity;
  const directTransfer = distToMarket <= SMALL_RADIUS;

  // 4. Transfer item based on delivery method
  if (directTransfer) {
    // Direct transfer — item goes straight to buyer's inventory
    await supabase.from('items')
      .update({ owner_id: buyer.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null })
      .eq('id', listing.item_id);
    if (gameState.loaded) {
      const gi = gameState.getItemById(listing.item_id);
      if (gi) {
        const updated = { ...gi, owner_id: buyer.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null };
        gameState.upsertItem(updated);
        gameState.markDirty('items', updated.id);
      }
    }
  } else if (bLat != null && bLng != null && marketLat && marketLng) {
    // Courier delivery — do NOT transfer owner_id yet, keep seller as owner until pickup
    const { data: courier } = await supabase
      .from('couriers')
      .insert({
        listing_id: listing.id,
        item_id: listing.item_id,
        owner_id: buyer.id,
        type: 'delivery',
        start_lat: marketLat,
        start_lng: marketLng,
        target_lat: bLat,
        target_lng: bLng,
        current_lat: marketLat,
        current_lng: marketLng,
        speed: COURIER_SPEED_DELIVERY,
        hp: COURIER_HP,
        max_hp: COURIER_HP,
        status: 'moving',
      })
      .select('id')
      .single();
    if (courier) {
      courierId = courier.id;
      if (gameState.loaded) {
        gameState.upsertCourier({
          id: courier.id, listing_id: listing.id, item_id: listing.item_id, owner_id: buyer.id,
          type: 'delivery', start_lat: marketLat, start_lng: marketLng,
          target_lat: bLat, target_lng: bLng,
          current_lat: marketLat, current_lng: marketLng,
          speed: COURIER_SPEED_DELIVERY, hp: COURIER_HP, max_hp: COURIER_HP,
          status: 'moving', created_at: new Date().toISOString(),
        });
      }
      // Mark item as in-transit (owner stays seller, on_market false, held_by_courier set)
      await supabase.from('items')
        .update({ on_market: false, equipped: false, held_by_courier: courier.id, held_by_market: null })
        .eq('id', listing.item_id);
      if (gameState.loaded) {
        const gi = gameState.getItemById(listing.item_id);
        if (gi) { gi.on_market = false; gi.equipped = false; gi.held_by_courier = courier.id; gi.held_by_market = null; gameState.markDirty('items', gi.id); }
      }
    } else {
      // Courier creation failed — direct transfer fallback
      await supabase.from('items')
        .update({ owner_id: buyer.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null })
        .eq('id', listing.item_id);
      if (gameState.loaded) {
        const gi = gameState.getItemById(listing.item_id);
        if (gi) {
          const updated = { ...gi, owner_id: buyer.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null };
          gameState.upsertItem(updated);
          gameState.markDirty('items', updated.id);
        }
      }
    }
  } else {
    // No position — direct transfer fallback
    await supabase.from('items')
      .update({ owner_id: buyer.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null })
      .eq('id', listing.item_id);
    if (gameState.loaded) {
      const gi = gameState.getItemById(listing.item_id);
      if (gi) {
        const updated = { ...gi, owner_id: buyer.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null };
        gameState.upsertItem(updated);
        gameState.markDirty('items', updated.id);
      }
    }
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
    .select('id, item_id, seller_id, status, item_type, core_id')
    .eq('id', listing_id)
    .maybeSingle();

  if (lErr) return res.status(500).json({ error: lErr.message });
  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.seller_id !== player.id) return res.status(403).json({ error: 'Not your listing' });
  if (listing.status !== 'active' && listing.status !== 'pending') return res.status(400).json({ error: 'Listing not active' });

  const cancelOps = [
    supabase.from('market_listings')
      .update({ status: 'cancelled' })
      .eq('id', listing_id),
    // Always cancel couriers for any listing type (cores can have to_market couriers too)
    supabase.from('couriers')
      .update({ status: 'cancelled' })
      .eq('listing_id', listing_id)
      .eq('status', 'moving'),
  ];

  if (listing.item_type === 'core' && listing.core_id) {
    cancelOps.push(supabase.from('cores').update({ on_market: false }).eq('id', listing.core_id));
  } else if (listing.item_id) {
    cancelOps.push(
      supabase.from('items')
        .update({ on_market: false, held_by_courier: null, held_by_market: null })
        .eq('id', listing.item_id),
    );
  }

  await Promise.all(cancelOps);

  // Update gameState
  if (gameState.loaded) {
    const gl = gameState.getListingById(listing_id);
    if (gl) { gl.status = 'cancelled'; gameState.markDirty('marketListings', gl.id); }
    // Always cancel couriers in gameState
    for (const c of gameState.couriers.values()) {
      if (c.listing_id === listing_id && c.status === 'moving') { c.status = 'cancelled'; gameState.markDirty('couriers', c.id); }
    }
    if (listing.item_type === 'core' && listing.core_id) {
      const core = gameState.cores.get(listing.core_id);
      if (core) { core.on_market = false; gameState.markDirty('cores', core.id); }
    } else if (listing.item_id) {
      const gi = gameState.getItemById(listing.item_id);
      if (gi) { gi.on_market = false; gi.held_by_courier = null; gi.held_by_market = null; gameState.markDirty('items', gi.id); }
    }
  }

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

  // Read from gameState (DB position may be stale — batch persist writes every 30s)
  const courier = gameState.loaded ? gameState.getCourierById(courier_id) : null;
  if (!courier) return res.status(404).json({ error: 'Courier not found' });

  // Resolve core_id from listing (not stored on courier)
  let _courierCoreId = null;
  if (courier.listing_id) {
    const listing = gameState.getListingById(courier.listing_id);
    if (listing?.core_id) _courierCoreId = listing.core_id;
    else {
      const { data: dbListing } = await supabase.from('market_listings').select('core_id').eq('id', courier.listing_id).maybeSingle();
      if (dbListing?.core_id) _courierCoreId = dbListing.core_id;
    }
  }
  if (courier.status !== 'moving') return res.status(400).json({ error: 'Courier not moving' });
  if (courier.owner_id === player.id) return res.status(400).json({ error: 'Cannot attack your own courier' });

  // Use server-side position for distance check
  const gsAttacker = gameState.getPlayerByTgId(Number(telegram_id));
  if (!gsAttacker?.last_lat || !gsAttacker?.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(gsAttacker.last_lat, gsAttacker.last_lng, courier.current_lat, courier.current_lng);
  const _mktFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  if (dist > LARGE_RADIUS + (_mktFx.radius_bonus || 0)) {
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
    // Atomic kill: only first attacker to flip status moving→killed wins.
    // Prevents two attackers each creating a loot drop for the same courier
    // (item duplication exploit).
    const { data: courierKilled } = await supabase.from('couriers')
      .update({ status: 'killed', hp: 0 })
      .eq('id', courier_id).eq('status', 'moving')
      .select('id').maybeSingle();
    if (!courierKilled) return res.status(409).json({ error: 'Курьер уже убит' });

    const dropPos = findSafeDropPosition(courier.current_lat, courier.current_lng, gameState);
    const { data: drop } = await supabase
      .from('courier_drops')
      .insert({
        courier_id: courier.id,
        item_id: courier.item_id || null,
        core_id: _courierCoreId || null,
        listing_id: courier.listing_id,
        lat: dropPos.lat,
        lng: dropPos.lng,
        drop_type: 'loot',
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    // Update gameState
    if (gameState.loaded) {
      const gc = gameState.getCourierById(courier_id);
      if (gc) { gc.status = 'killed'; gc.hp = 0; gameState.markDirty('couriers', gc.id); }
      if (drop) gameState.upsertDrop({ ...drop, courier_id: courier.id, item_id: courier.item_id, core_id: _courierCoreId, listing_id: courier.listing_id, lat: dropPos.lat, lng: dropPos.lng, drop_type: 'loot', picked_up: false });
    }

    // Item/core dropped — keep held_by_courier to protect item until loot is picked up (or expires)
    if (courier.item_id) {
      await supabase.from('items')
        .update({ held_by_market: null, on_market: false })
        .eq('id', courier.item_id);
    }
    if (_courierCoreId) {
      await supabase.from('cores')
        .update({ on_market: false })
        .eq('id', _courierCoreId);
      if (gameState.loaded) {
        const core = gameState.cores.get(_courierCoreId);
        if (core) { core.on_market = false; gameState.markDirty('cores', core.id); }
      }
    }

    // Notify courier owner (in-game + Telegram)
    const courierKillMsg = '💥 Ваш курьер был уничтожен! Предмет выпал на карту.';
    notify(courier.owner_id, 'courier_killed', courierKillMsg,
      { courier_id: courier.id, listing_id: courier.listing_id });
    const { data: courierOwner } = await supabase.from('players').select('telegram_id').eq('id', courier.owner_id).maybeSingle();
    if (courierOwner?.telegram_id) sendTelegramNotification(courierOwner.telegram_id, courierKillMsg, buildAttackButton(courier.current_lat, courier.current_lng));

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

  // Update gameState
  if (gameState.loaded) {
    const gc = gameState.getCourierById(courier_id);
    if (gc) { gc.hp = newHp; gameState.markDirty('couriers', gc.id); }
  }

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

  const { player, error: pErr } = await getPlayerByTelegramId(telegram_id, 'id');
  if (pErr) return res.status(500).json({ error: pErr });
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const { data: drop, error: dErr } = await supabase
    .from('courier_drops')
    .select(`
      id, item_id, core_id, listing_id, lat, lng, picked_up, expires_at, drop_type, owner_id, coins,
      couriers!courier_drops_courier_id_fkey(type, owner_id, listing_id)
    `)
    .eq('id', drop_id)
    .maybeSingle();

  if (dErr) return res.status(500).json({ error: dErr.message });
  if (!drop) return res.status(404).json({ error: 'Drop not found' });
  if (drop.picked_up) return res.status(400).json({ error: 'Already picked up' });
  // Loot drops expire; delivery drops don't
  if (drop.drop_type !== 'delivery' && drop.expires_at && new Date(drop.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Drop expired' });
  }

  // Use server-side position for distance check
  const gsPickup = gameState.getPlayerByTgId(Number(telegram_id));
  if (!gsPickup?.last_lat || !gsPickup?.last_lng) return res.status(400).json({ error: 'Position unknown' });
  const dist = haversine(gsPickup.last_lat, gsPickup.last_lng, drop.lat, drop.lng);
  const _dropFx = getPlayerSkillEffects(gameState.getPlayerSkills(telegram_id));
  if (dist > SMALL_RADIUS + (_dropFx.radius_bonus || 0)) {
    return res.status(400).json({ error: 'Too far from drop', distance: Math.round(dist) });
  }

  // ── Delivery box: only the buyer (courier owner) can pick up ──
  if (drop.drop_type === 'delivery') {
    let courierOwner = drop.owner_id || drop.couriers?.owner_id;
    // Fallback: if courier was deleted by cleanup, check listing buyer_id
    if (!courierOwner && drop.listing_id) {
      const { data: listing } = await supabase.from('market_listings').select('buyer_id').eq('id', drop.listing_id).maybeSingle();
      courierOwner = listing?.buyer_id;
    }
    if (!courierOwner) {
      return res.status(403).json({ error: 'Не удалось определить владельца посылки' });
    }
    if (courierOwner !== player.id) {
      return res.status(403).json({ error: 'Это не ваша посылка' });
    }
    // Atomic claim: only the first request to flip picked_up=false→true wins.
    // Prevents concurrent pickup duplication exploit.
    const { data: dropClaimed } = await supabase.from('courier_drops')
      .update({ picked_up: true, picked_by: player.id })
      .eq('id', drop_id).eq('picked_up', false)
      .select('id').maybeSingle();
    if (!dropClaimed) return res.status(409).json({ error: 'Уже подобрано' });

    const pickupOps = [];
    if (drop.item_id) {
      pickupOps.push(supabase.from('items')
        .update({ owner_id: player.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null })
        .eq('id', drop.item_id));
    }
    if (drop.core_id) {
      pickupOps.push(supabase.from('cores')
        .update({ owner_id: Number(telegram_id), on_market: false, mine_cell_id: null, slot_index: null })
        .eq('id', drop.core_id));
    }
    if (pickupOps.length) await Promise.all(pickupOps);

    // Update gameState
    if (gameState.loaded) {
      const gd = gameState.getDropById(drop_id);
      if (gd) { gd.picked_up = true; gameState.markDirty('courierDrops', gd.id); }
      if (drop.item_id) {
        const gi = gameState.getItemById(drop.item_id);
        if (gi) {
          const updated = { ...gi, owner_id: player.id, on_market: false, equipped: false, held_by_courier: null, held_by_market: null };
          gameState.upsertItem(updated);
          gameState.markDirty('items', updated.id);
        }
      }
      if (drop.core_id) {
        const core = gameState.cores.get(drop.core_id);
        if (core) { core.owner_id = Number(telegram_id); core.on_market = false; core.mine_cell_id = null; core.slot_index = null; gameState.markDirty('cores', core.id); }
      }
    }

    if (drop.core_id) {
      const core = gameState.loaded ? gameState.cores.get(drop.core_id) : null;
      return res.json({ success: true, core: core ? { id: core.id, core_type: core.core_type, level: core.level } : null, message: '🎁 Ядро получено!' });
    }
    const { data: item } = await supabase
      .from('items')
      .select('id, type, rarity, name, emoji, attack, crit_chance, defense, upgrade_level, base_attack, base_crit_chance, base_defense, block_chance')
      .eq('id', drop.item_id)
      .maybeSingle();
    return res.json({ success: true, item, message: '🎁 Получено!' });
  }

  // ── Coin delivery drop (from collector) ──
  if (drop.drop_type === 'coin_delivery') {
    // Check ownership from gameState (owner_id stored on drop in memory)
    const gd = gameState.loaded ? gameState.getDropById(drop_id) : null;
    const coinOwner = drop.owner_id || gd?.owner_id || drop.couriers?.owner_id;
    // Allow pickup if no owner info (old drops before owner_id fix)
    if (coinOwner && coinOwner !== player.id) {
      return res.status(403).json({ error: 'Это не ваша посылка' });
    }
    // If no coins stored in memory (server restarted), still mark as picked up
    if (!gd?._coins && !coinOwner) {
      // Old drop — just mark as picked up without giving coins
    }
    const coins = gd?._coins || gd?.coins || drop.coins || 0;

    // Atomic claim: only first request wins
    const { data: coinClaimed } = await supabase.from('courier_drops')
      .update({ picked_up: true, picked_by: player.id })
      .eq('id', drop_id).eq('picked_up', false)
      .select('id').maybeSingle();
    if (!coinClaimed) return res.status(409).json({ error: 'Уже подобрано' });
    if (gd) { gd.picked_up = true; }

    // Give coins to player
    if (coins > 0 && gameState.loaded) {
      const gp = gameState.getPlayerById(player.id);
      if (gp) {
        gp.coins = (gp.coins || 0) + coins;
        gameState.markDirty('players', gp.id);
        await supabase.from('players').update({ coins: gp.coins }).eq('id', gp.id);
      }
    }

    return res.json({ success: true, coins, message: `💰 +${coins} монет!` });
  }

  // ── Loot drop: anyone can pick up ──
  // Atomic claim: only the first request to flip picked_up=false→true wins.
  // Prevents concurrent pickup duplication exploit (cross-player race).
  const { data: lootClaimed } = await supabase.from('courier_drops')
    .update({ picked_up: true, picked_by: player.id })
    .eq('id', drop_id).eq('picked_up', false)
    .select('id').maybeSingle();
  if (!lootClaimed) return res.status(409).json({ error: 'Уже подобрано' });

  const lootOps = [];
  if (drop.item_id) {
    lootOps.push(supabase.from('items')
      .update({ owner_id: player.id, on_market: false, held_by_courier: null, held_by_market: null })
      .eq('id', drop.item_id));
  }
  if (drop.core_id) {
    lootOps.push(supabase.from('cores')
      .update({ owner_id: Number(telegram_id), on_market: false, mine_cell_id: null, slot_index: null })
      .eq('id', drop.core_id));
  }
  if (lootOps.length) await Promise.all(lootOps);

  // Update gameState
  if (gameState.loaded) {
    const gd = gameState.getDropById(drop_id);
    if (gd) { gd.picked_up = true; gameState.markDirty('courierDrops', gd.id); }
    if (drop.item_id) {
      const gi = gameState.getItemById(drop.item_id);
      if (gi) {
          const updated = { ...gi, owner_id: player.id, on_market: false, held_by_courier: null, held_by_market: null };
          gameState.upsertItem(updated);
          gameState.markDirty('items', updated.id);
        }
    }
    if (drop.core_id) {
      const core = gameState.cores.get(drop.core_id);
      if (core) { core.owner_id = Number(telegram_id); core.on_market = false; core.mine_cell_id = null; core.slot_index = null; gameState.markDirty('cores', core.id); }
    }
  }

  let message = drop.core_id ? 'Ядро подобрано!' : 'Предмет подобран!';
  if (drop.couriers?.type === 'delivery' && drop.listing_id) {
    // Mark listing as intercepted (only if still 'sold')
    const { data: intercepted } = await supabase.from('market_listings')
      .update({ status: 'intercepted' })
      .eq('id', drop.listing_id).eq('status', 'sold')
      .select('id').maybeSingle();

    if (intercepted) {
      // Update gameState listing status
      if (gameState.loaded) {
        const gl = gameState.getListingById(drop.listing_id);
        if (gl) { gl.status = 'intercepted'; gameState.markDirty('marketListings', gl.id); }
      }
      message = drop.core_id ? 'Курьер перехвачен! Ядро украдено.' : 'Курьер перехвачен! Предмет украдено.';
    }
  }

  if (drop.core_id) {
    const core = gameState.loaded ? gameState.cores.get(drop.core_id) : null;
    return res.json({ success: true, core: core ? { id: core.id, core_type: core.core_type, level: core.level } : null, message });
  }

  const { data: item } = await supabase
    .from('items')
    .select('id, type, rarity, name, emoji, attack, crit_chance, defense, upgrade_level, base_attack, base_crit_chance, base_defense, block_chance')
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
    .select('id, start_lat, start_lng, current_lat, current_lng, target_lat, target_lng, speed, status, created_at, type, item_id, core_id, listing_id, to_market_id')
    .eq('status', 'moving');

  if (error) {
    console.error('[market/move-couriers] error:', error);
    return res.status(500).json({ error: error.message });
  }

  // Time-based: compute position from elapsed time since creation
  // Use per-courier speed from DB (deg/tick where tick=4s → speed/4 deg/sec)
  const now = Date.now();
  const updates = [];
  const arrived = [];

  for (const c of (couriers || [])) {
    const routeLat = c.target_lat - c.start_lat;
    const routeLng = c.target_lng - c.start_lng;
    const routeDist = Math.sqrt(routeLat * routeLat + routeLng * routeLng);

    if (routeDist < 0.0001) {
      arrived.push(c);
      continue;
    }

    // speed is in deg/tick (4s), convert to deg/sec
    const speedDegPerSec = (c.speed || 0.0002) / 4;
    const elapsedSec = (now - new Date(c.created_at).getTime()) / 1000;
    const traveled = speedDegPerSec * elapsedSec;
    const progress = Math.min(traveled / routeDist, 1.0);

    // Max delivery time: delivery 5min, to_market 30min
    const maxSec = c.type === 'delivery' ? 300 : 1800;
    if (progress >= 0.99 || elapsedSec > maxSec) {
      arrived.push(c);
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

  const arrivedIds = arrived.map(c => c.id);
  if (arrivedIds.length > 0) {
    updatePromises.push(
      supabase.from('couriers')
        .update({ status: 'delivered' })
        .in('id', arrivedIds)
    );
  }

  if (updatePromises.length > 0) await Promise.all(updatePromises);

  // Handle delivered couriers: transfer held_by, activate pending listings
  if (arrived.length > 0) {
    try {
      for (const dc of arrived) {
        if (dc.type === 'to_market' && dc.listing_id) {
          // Courier arrived at market → activate the listing, transfer item to market
          await supabase.from('market_listings')
            .update({ status: 'active' })
            .eq('id', dc.listing_id)
            .eq('status', 'pending');
          if (dc.item_id) {
            await supabase.from('items')
              .update({ held_by_courier: null, held_by_market: dc.to_market_id || null })
              .eq('id', dc.item_id);
          }
          notify(dc.owner_id, 'item_delivered', '🎪 Курьер доставил товар на рынок!', { listing_id: dc.listing_id });
        } else if (dc.type === 'delivery') {
          // Delivery complete → create a pickup box near buyer's last position
          const { data: buyerPos } = await supabase
            .from('players').select('last_lat, last_lng').eq('id', dc.owner_id).single();
          const dropLat = (buyerPos?.last_lat ?? dc.target_lat) + (Math.random() - 0.5) * 0.0004;
          const dropLng = (buyerPos?.last_lng ?? dc.target_lng) + (Math.random() - 0.5) * 0.0004;
          const deliveryExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
          const { error: dropErr } = await supabase.from('courier_drops').insert({
            courier_id: dc.id,
            owner_id: dc.owner_id,
            item_id: dc.item_id || null,
            core_id: dc._core_id || dc.core_id || null,
            listing_id: dc.listing_id,
            lat: dropLat,
            lng: dropLng,
            drop_type: 'delivery',
            expires_at: deliveryExpiry,
          });
          if (dropErr) console.error('[move-couriers] delivery drop insert error:', dropErr);
          if (dc.item_id) {
            await supabase.from('items')
              .update({ held_by_courier: null, held_by_market: null })
              .eq('id', dc.item_id);
            // on_market stays true until buyer picks up the box
          }
          notify(dc.owner_id, 'delivery_arrived', '📦 Ваш заказ доставлен! Найдите коробку на карте.', { courier_id: dc.id });
        }
      }
    } catch (e) { console.error('[move-couriers] delivery handling error:', e.message); }
  }

  // ── 2. Expire old drops → return items to owners ───────────
  try {
    const { data: expiredDrops } = await supabase
      .from('courier_drops')
      .select('id, item_id, core_id, courier_id, listing_id, drop_type')
      .eq('picked_up', false)
      .lt('expires_at', nowISO)
      .limit(50);

    if (expiredDrops && expiredDrops.length > 0) {
      for (const drop of expiredDrops) {
        // Return item/core to original owner (on_market = false)
        if (drop.item_id) {
          await supabase.from('items')
            .update({ on_market: false, held_by_courier: null, held_by_market: null })
            .eq('id', drop.item_id);
        }
        if (drop.core_id) {
          await supabase.from('cores')
            .update({ on_market: false })
            .eq('id', drop.core_id);
          if (gameState.loaded) {
            const core = gameState.cores.get(drop.core_id);
            if (core) { core.on_market = false; gameState.markDirty('cores', core.id); }
          }
        }
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
      log(`[move-couriers] expired ${expiredDrops.length} drops, items returned`);
    }
  } catch (e) {
    console.error('[move-couriers] drop expiration error:', e.message);
  }

  // ── 3. Expire old listings (past expires_at) ───────────────
  try {
    const { data: expiredListings } = await supabase
      .from('market_listings')
      .select('id, item_id, seller_id, item_type, core_id')
      .in('status', ['active', 'pending'])
      .lt('expires_at', nowISO)
      .limit(50);

    if (expiredListings && expiredListings.length > 0) {
      for (const listing of expiredListings) {
        await supabase.from('market_listings')
          .update({ status: 'expired' })
          .eq('id', listing.id);

        if (listing.item_type === 'core' && listing.core_id) {
          await supabase.from('cores').update({ on_market: false }).eq('id', listing.core_id);
          if (gameState.loaded) {
            const core = gameState.cores.get(listing.core_id);
            if (core) { core.on_market = false; gameState.markDirty('cores', core.id); }
          }
        } else if (listing.item_id) {
          await supabase.from('items')
            .update({ on_market: false, held_by_courier: null, held_by_market: null })
            .eq('id', listing.item_id);
          // Kill any active courier for this listing
          await supabase.from('couriers')
            .update({ status: 'cancelled' })
            .eq('listing_id', listing.id)
            .eq('status', 'moving');
        }
      }
      log(`[move-couriers] expired ${expiredListings.length} listings`);
    }
  } catch (e) {
    console.error('[move-couriers] listing expiration error:', e.message);
  }

  // ── 4. Return remaining moving couriers ────────────────────
  const { data: allCouriers } = await supabase
    .from('couriers')
    .select('id, type, owner_id, current_lat, current_lng, target_lat, target_lng, hp, max_hp, speed, status, listing_id, owner:players!couriers_owner_id_fkey(game_username,username)')
    .eq('status', 'moving');

  return res.json({
    moved: updates.length,
    delivered: arrived.length,
    couriers: allCouriers || [],
  });
}

/* ── Action: search-by-code (GET) ─────────────────────────── */

async function handleSearchByCode(req, res) {
  const { telegram_id, code } = req.query;
  if (!telegram_id || !code) return res.status(400).json({ error: 'telegram_id and code required' });

  const trimmed = code.trim().toUpperCase();
  if (trimmed.length !== 6) return res.status(400).json({ error: 'Code must be 6 characters' });

  const { data: listing, error } = await supabase
    .from('market_listings')
    .select(`
      id, price_diamonds, is_private, created_at, expires_at,
      market_id,
      items(id, type, rarity, name, emoji, stat_value, attack, crit_chance, defense, upgrade_level, block_chance, plus),
      seller:players!market_listings_seller_id_fkey(id, username, game_username, avatar)
    `)
    .eq('private_code', trimmed)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!listing) return res.status(404).json({ error: 'Лот не найден или истёк' });

  return res.json({ listing });
}

/* ── Main router ───────────────────────────────────────────── */

marketRouter.get('/', async (req, res) => {
  const { action } = req.query;
  if (action === 'listings')       return handleListings(req, res);
  if (action === 'my-listings')    return handleMyListings(req, res);
  if (action === 'search-by-code') return handleSearchByCode(req, res);
  return res.status(400).json({ error: 'Unknown GET action' });
});

marketRouter.post('/', async (req, res) => {
  const { action, telegram_id } = req.body || {};
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  return withPlayerLock(telegram_id, async () => {
    if (action === 'list-item')       return handleListItem(req, res);
    if (action === 'buy')             return handleBuy(req, res);
    if (action === 'cancel')          return handleCancel(req, res);
    if (action === 'attack-courier')  return handleAttackCourier(req, res);
    if (action === 'pickup-drop')     return handlePickupDrop(req, res);
    if (action === 'move-couriers')   return handleMoveCouriers(req, res);
    return res.status(400).json({ error: 'Unknown POST action' });
  });
});
