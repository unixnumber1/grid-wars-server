import { supabase } from '../../lib/supabase.js';

class GameState {
  constructor() {
    this._loaded = false;
    // Primary Maps — keyed by the most useful lookup key
    this.players = new Map();       // id (UUID) -> full row
    this.playersByTgId = new Map(); // telegram_id (number) -> same object ref
    this.headquarters = new Map();  // id -> full row
    this.hqByPlayerId = new Map();  // player_id -> same object ref
    this.mines = new Map();         // id -> full row
    this.mineByCellId = new Map();  // cell_id -> same object ref
    this.bots = new Map();          // id -> full row
    this.vases = new Map();         // id -> full row
    this.items = new Map();         // id -> full row
    this.markets = new Map();       // id -> full row
    this.marketListings = new Map();// id -> full row
    this.couriers = new Map();      // id -> full row
    this.courierDrops = new Map();  // id -> full row
    this.notifications = new Map(); // id -> full row
    this.clans = new Map();         // id -> full row
    this.clanMembers = new Map();   // id -> full row
    this.clanHqs = new Map();       // id -> full row
    this.oreNodes = new Map();       // id -> full row
    this.collectors = new Map();     // id -> full row
    this.monuments = new Map();      // id -> full row
    this.monumentDefenders = new Map(); // id -> full row
    this.monumentDamage = new Map(); // monument_id -> Map(player_id -> damage)
    this.cores = new Map();            // id -> full row
    this.activeWaves = new Map();    // monument_id -> { wave_number, last_wave_at, last_attack_at }
    this.appSettings = new Map();   // key -> value (string)
    this.pvpCooldowns = [];         // array of {attacker_id, defender_id, expires_at}
    this.pvpLog = new Map();        // id -> full row

    // Dirty tracking
    this._dirty = {
      players: new Set(),
      headquarters: new Set(),
      mines: new Set(),
      bots: new Set(),
      vases: new Set(),
      items: new Set(),
      markets: new Set(),
      marketListings: new Set(),
      couriers: new Set(),
      courierDrops: new Set(),
      notifications: new Set(),
      clans: new Set(),
      clanMembers: new Set(),
      clanHqs: new Set(),
      oreNodes: new Set(),
      collectors: new Set(),
      monuments: new Set(),
      cores: new Set(),
    };
  }

  get loaded() { return this._loaded; }

  // Load all rows from a table with pagination (Supabase caps at 1000 per request)
  async _loadAll(table, extraFn) {
    const PAGE = 1000;
    let all = [];
    let offset = 0;
    while (true) {
      let q = supabase.from(table).select('*');
      if (extraFn) q = extraFn(q);
      q = q.range(offset, offset + PAGE - 1);
      const { data, error } = await q;
      if (error) { console.error(`[gameState] ${table} load error:`, error.message); break; }
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  }

  async loadFromDB() {
    console.log('[gameState] Loading from Supabase...');
    const t0 = Date.now();

    // Load all tables in parallel (paginated for large tables)
    const [players, hqs, mines, bots, vases, items, markets, listings, couriers, drops, notifications, clans, members, clanHqs, settings, pvpCd, pvpLog, oreNodes, collectors, monuments, monumentDefs, cores] = await Promise.all([
      this._loadAll('players'),
      this._loadAll('headquarters'),
      this._loadAll('mines'),
      this._loadAll('bots', q => q.gt('expires_at', new Date().toISOString())),
      this._loadAll('vases'),
      this._loadAll('items'),
      this._loadAll('markets'),
      this._loadAll('market_listings'),
      this._loadAll('couriers'),
      this._loadAll('courier_drops'),
      this._loadAll('notifications', q => q.eq('read', false)),
      this._loadAll('clans'),
      this._loadAll('clan_members'),
      this._loadAll('clan_headquarters'),
      this._loadAll('app_settings'),
      this._loadAll('pvp_cooldowns'),
      this._loadAll('pvp_log', q => q.order('created_at', { ascending: false })),
      this._loadAll('ore_nodes'),
      this._loadAll('collectors'),
      this._loadAll('monuments'),
      this._loadAll('monument_defenders', q => q.eq('alive', true)),
      this._loadAll('cores'),
    ]);

    // Index players
    for (const p of (players || [])) {
      this.players.set(p.id, p);
      this.playersByTgId.set(Number(p.telegram_id), p);
    }
    // Index HQs
    for (const h of (hqs || [])) {
      this.headquarters.set(h.id, h);
      this.hqByPlayerId.set(h.player_id, h);
    }
    // Index mines
    for (const m of (mines || [])) {
      this.mines.set(m.id, m);
      if (m.cell_id) this.mineByCellId.set(m.cell_id, m);
    }
    // Simple maps
    for (const b of (bots || []))          this.bots.set(b.id, b);
    for (const v of (vases || []))         this.vases.set(v.id, v);
    for (const i of (items || []))         this.items.set(i.id, i);
    for (const m of (markets || []))       this.markets.set(m.id, m);
    for (const l of (listings || []))      this.marketListings.set(l.id, l);
    for (const c of (couriers || []))      this.couriers.set(c.id, c);
    for (const d of (drops || []))         this.courierDrops.set(d.id, d);
    for (const n of (notifications || [])) this.notifications.set(n.id, n);
    for (const c of (clans || []))         this.clans.set(c.id, c);
    for (const m of (members || []))       this.clanMembers.set(m.id, m);
    for (const h of (clanHqs || []))       this.clanHqs.set(h.id, h);
    for (const s of (settings || []))      this.appSettings.set(s.key, s.value);
    this.pvpCooldowns = pvpCd || [];
    for (const p of (pvpLog || []))        this.pvpLog.set(p.id, p);
    for (const o of (oreNodes || []))     this.oreNodes.set(o.id, o);
    for (const c of (collectors || []))  this.collectors.set(c.id, c);
    for (const m of (monuments || []))   this.monuments.set(m.id, m);
    for (const d of (monumentDefs || []))this.monumentDefenders.set(d.id, d);
    for (const c of (cores || []))      this.cores.set(c.id, c);

    this._loaded = true;
    console.log('[gameState] Loaded in', Date.now() - t0, 'ms:', this.stats());
  }

  stats() {
    return {
      players: this.players.size,
      hqs: this.headquarters.size,
      mines: this.mines.size,
      bots: this.bots.size,
      vases: this.vases.size,
      items: this.items.size,
      markets: this.markets.size,
      listings: this.marketListings.size,
      couriers: this.couriers.size,
      drops: this.courierDrops.size,
      clans: this.clans.size,
      clanHqs: this.clanHqs.size,
      oreNodes: this.oreNodes.size,
      collectors: this.collectors.size,
      monuments: this.monuments.size,
      cores: this.cores.size,
    };
  }

  // -- Dirty tracking --
  markDirty(collection, id) {
    if (this._dirty[collection]) this._dirty[collection].add(id);
  }

  getDirtyAndClear() {
    const result = {};
    for (const [key, set] of Object.entries(this._dirty)) {
      if (set.size > 0) {
        result[key] = [...set];
        set.clear();
      }
    }
    return result;
  }

  // -- Spatial queries --
  // Returns objects within bounding box {n, s, e, w}
  getMapSnapshot(n, s, e, w, currentPlayerId, nowMs) {
    const nowISO = new Date(nowMs).toISOString();
    const ONLINE_MS = 3 * 60 * 1000;

    // Pre-compute best mine level per player (for HQ icons)
    const bestMineLevelByPlayer = new Map();
    for (const m of this.mines.values()) {
      if (m.status === 'destroyed' || !m.owner_id) continue;
      const cur = bestMineLevelByPlayer.get(m.owner_id) || 0;
      if (m.level > cur) bestMineLevelByPlayer.set(m.owner_id, m.level);
    }

    // HQs in bbox
    const headquarters = [];
    for (const hq of this.headquarters.values()) {
      if (hq.lat >= s && hq.lat <= n && hq.lng >= w && hq.lng <= e) {
        const owner = this.players.get(hq.player_id);
        headquarters.push({
          ...hq,
          players: owner ? { username: owner.username, game_username: owner.game_username, avatar: owner.avatar, last_seen: owner.last_seen, level: owner.level } : null,
          is_mine: hq.player_id === currentPlayerId,
          is_online: owner?.last_seen ? (nowMs - new Date(owner.last_seen).getTime()) < ONLINE_MS : false,
          best_mine_level: bestMineLevelByPlayer.get(hq.player_id) || 0,
        });
      }
    }

    // Mines in bbox (exclude destroyed)
    const mines = [];
    for (const m of this.mines.values()) {
      if (m.status === 'destroyed') continue;
      if (m.lat >= s && m.lat <= n && m.lng >= w && m.lng <= e) {
        const owner = this.players.get(m.owner_id);
        mines.push({
          ...m,
          players: owner ? { username: owner.username, game_username: owner.game_username, avatar: owner.avatar, level: owner.level } : null,
          is_mine: m.owner_id === currentPlayerId,
        });
      }
    }

    // Bots in bbox (not expired)
    const bots = [];
    for (const b of this.bots.values()) {
      if (new Date(b.expires_at).getTime() <= nowMs) continue;
      if (b.lat >= s && b.lat <= n && b.lng >= w && b.lng <= e) {
        bots.push(b);
      }
    }

    // Vases in bbox (not broken, not expired)
    const vases = [];
    for (const v of this.vases.values()) {
      if (v.broken_by) continue;
      if (new Date(v.expires_at).getTime() <= nowMs) continue;
      if (v.lat >= s && v.lat <= n && v.lng >= w && v.lng <= e) {
        vases.push({ id: v.id, lat: v.lat, lng: v.lng, expires_at: v.expires_at });
      }
    }

    // Online players in bbox
    const online_players = [];
    for (const p of this.players.values()) {
      if (p.id === currentPlayerId) continue;
      if (!p.last_lat || !p.last_lng || !p.last_seen) continue;
      if (nowMs - new Date(p.last_seen).getTime() > ONLINE_MS) continue;
      if (p.last_lat >= s && p.last_lat <= n && p.last_lng >= w && p.last_lng <= e) {
        online_players.push({
          id: p.id, telegram_id: p.telegram_id, username: p.username, game_username: p.game_username,
          avatar: p.avatar, last_lat: p.last_lat, last_lng: p.last_lng, last_seen: p.last_seen,
          level: p.level, shield_until: p.shield_until, bonus_hp: p.bonus_hp, bonus_attack: p.bonus_attack,
        });
      }
    }

    // Couriers in bbox (status=moving)
    const couriers = [];
    for (const c of this.couriers.values()) {
      if (c.status !== 'moving') continue;
      if (c.current_lat >= s && c.current_lat <= n && c.current_lng >= w && c.current_lng <= e) {
        const owner = this.players.get(c.owner_id);
        couriers.push({
          ...c,
          owner: owner ? { game_username: owner.game_username, username: owner.username } : null,
        });
      }
    }

    // Courier drops in bbox (not picked up, not expired)
    const courier_drops = [];
    for (const d of this.courierDrops.values()) {
      if (d.picked_up) continue;
      if (d.expires_at && new Date(d.expires_at).getTime() <= nowMs) continue;
      if (d.lat >= s && d.lat <= n && d.lng >= w && d.lng <= e) {
        const item = this.items.get(d.item_id);
        const courier = this.couriers.get(d.courier_id);
        courier_drops.push({
          ...d,
          items: item ? { name: item.name, emoji: item.emoji, rarity: item.rarity, type: item.type, attack: item.attack, crit_chance: item.crit_chance, defense: item.defense } : null,
          couriers: courier ? { owner_id: courier.owner_id } : null,
        });
      }
    }

    // Markets in bbox
    const marketsArr = [];
    for (const m of this.markets.values()) {
      if (m.lat >= s && m.lat <= n && m.lng >= w && m.lng <= e) {
        marketsArr.push(m);
      }
    }

    // Clan HQs in bbox
    const clan_hqs = [];
    for (const ch of this.clanHqs.values()) {
      if (ch.lat >= s && ch.lat <= n && ch.lng >= w && ch.lng <= e) {
        const clan = this.clans.get(ch.clan_id);
        clan_hqs.push({
          ...ch,
          is_mine: ch.player_id === currentPlayerId,
          is_active: !!ch.clan_id,
          clan_name: clan?.name || null,
          symbol: clan?.symbol || null,
          color: clan?.color || null,
          clan_level: clan?.level || 1,
          clans: clan ? { name: clan.name, symbol: clan.symbol, color: clan.color, level: clan.level } : null,
        });
      }
    }

    // Ore nodes in bbox (not expired)
    const ore_nodes = [];
    for (const o of this.oreNodes.values()) {
      if (new Date(o.expires_at).getTime() <= nowMs) continue;
      if (o.lat >= s && o.lat <= n && o.lng >= w && o.lng <= e) {
        const owner = o.owner_id ? this.getPlayerById(o.owner_id) || this.getPlayerByTgId(o.owner_id) : null;
        ore_nodes.push({
          ...o,
          owner_name: owner?.game_username || owner?.username || null,
          owner_avatar: owner?.avatar || null,
          owner_online: owner?.last_seen ? (nowMs - new Date(owner.last_seen).getTime()) < ONLINE_MS : false,
          is_mine: o.owner_id && (o.owner_id === currentPlayerId || String(o.owner_id) === String(currentPlayerId)),
        });
      }
    }

    // Collectors in bbox
    const collectorsArr = [];
    for (const c of this.collectors.values()) {
      if (c.lat >= s && c.lat <= n && c.lng >= w && c.lng <= e) {
        const owner = this.players.get(c.owner_id);
        collectorsArr.push({
          ...c,
          is_mine: c.owner_id === currentPlayerId,
          owner_name: owner?.game_username || owner?.username || null,
          owner_avatar: owner?.avatar || null,
        });
      }
    }

    // Monuments in bbox
    const monumentsArr = [];
    for (const m of this.monuments.values()) {
      if (m.lat >= s && m.lat <= n && m.lng >= w && m.lng <= e) {
        monumentsArr.push({
          id: m.id, lat: m.lat, lng: m.lng, level: m.level, name: m.name,
          hp: m.hp, max_hp: m.max_hp,
          shield_hp: m.shield_hp, max_shield_hp: m.max_shield_hp,
          wave_shield_hp: m.wave_shield_hp || 0,
          phase: m.phase, raid_started_at: m.raid_started_at,
          respawn_at: m.respawn_at,
        });
      }
    }

    // Monument defenders in bbox (alive only)
    const monumentDefendersArr = [];
    for (const d of this.monumentDefenders.values()) {
      if (!d.alive) continue;
      if (d.lat >= s && d.lat <= n && d.lng >= w && d.lng <= e) {
        monumentDefendersArr.push({
          id: d.id, monument_id: d.monument_id, emoji: d.emoji,
          hp: d.hp, max_hp: d.max_hp, lat: d.lat, lng: d.lng,
        });
      }
    }

    return { headquarters, mines, bots, vases, online_players, couriers, courier_drops, markets: marketsArr, clan_hqs, ore_nodes, collectors: collectorsArr, monuments: monumentsArr, monument_defenders: monumentDefendersArr };
  }

  // -- Player lookups --
  getPlayerByTgId(tgId) {
    return this.playersByTgId.get(Number(tgId)) || null;
  }

  getPlayerById(id) {
    return this.players.get(id) || null;
  }

  upsertPlayer(player) {
    this.players.set(player.id, player);
    this.playersByTgId.set(Number(player.telegram_id), player);
  }

  // -- Player mines (for income calc) --
  getPlayerMines(playerId) {
    const result = [];
    for (const m of this.mines.values()) {
      if (m.owner_id === playerId && m.status !== 'destroyed') result.push(m);
    }
    return result;
  }

  // -- Player items (inventory) --
  getPlayerItems(playerId) {
    const result = [];
    for (const i of this.items.values()) {
      if (i.owner_id === playerId && !i.on_market) result.push(i);
    }
    return result.sort((a, b) => new Date(b.obtained_at) - new Date(a.obtained_at));
  }

  // -- Player notifications (unread) --
  getPlayerNotifications(playerId, limit = 20) {
    const result = [];
    for (const n of this.notifications.values()) {
      if (n.player_id === playerId && !n.read) result.push(n);
    }
    return result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
  }

  // -- Bots --
  addBot(bot) {
    this.bots.set(bot.id, bot);
  }
  removeBot(id) {
    this.bots.delete(id);
  }
  getAllAliveBots(nowISO) {
    const result = [];
    for (const b of this.bots.values()) {
      if (b.expires_at && b.expires_at > nowISO) result.push(b);
    }
    return result;
  }
  getBotsNearby(lat, lng, radiusM, nowISO) {
    // Quick bounding-box pre-filter to avoid full iteration
    const result = [];
    const PAD = radiusM / 111000 * 1.5;
    for (const b of this.bots.values()) {
      if (b.expires_at && b.expires_at <= nowISO) continue;
      if (Math.abs(b.lat - lat) > PAD || Math.abs(b.lng - lng) > PAD) continue;
      result.push(b);
    }
    return result;
  }
  getBotCount(nowISO) {
    let count = 0;
    for (const b of this.bots.values()) {
      if (b.expires_at && b.expires_at > nowISO) count++;
    }
    return count;
  }
  purgeExpiredBots(nowISO) {
    const expired = [];
    for (const [id, b] of this.bots) {
      if (b.expires_at && b.expires_at <= nowISO) {
        expired.push(id);
      }
    }
    for (const id of expired) this.bots.delete(id);
    return expired;
  }

  // -- Vases --
  addVase(vase) { this.vases.set(vase.id, vase); }
  removeVase(id) { this.vases.delete(id); }
  clearAllVases() { this.vases.clear(); }

  // -- Mines --
  getMineById(id) { return this.mines.get(id) || null; }
  getMineByCellId(cellId) { return this.mineByCellId.get(cellId) || null; }
  upsertMine(mine) {
    this.mines.set(mine.id, mine);
    if (mine.cell_id) this.mineByCellId.set(mine.cell_id, mine);
  }
  removeMine(id) {
    const m = this.mines.get(id);
    if (m?.cell_id) this.mineByCellId.delete(m.cell_id);
    this.mines.delete(id);
  }

  // -- HQ --
  getHqByPlayerId(playerId) { return this.hqByPlayerId.get(playerId) || null; }
  upsertHq(hq) {
    this.headquarters.set(hq.id, hq);
    this.hqByPlayerId.set(hq.player_id, hq);
  }

  // -- Items --
  getItemById(id) { return this.items.get(id) || null; }
  upsertItem(item) { this.items.set(item.id, item); }
  removeItem(id) { this.items.delete(id); }

  // -- Markets --
  getMarketById(id) { return this.markets.get(id) || null; }
  upsertMarket(market) { this.markets.set(market.id, market); }
  getAllMarkets() { return [...this.markets.values()]; }

  // -- Market listings --
  upsertListing(listing) { this.marketListings.set(listing.id, listing); }
  getListingById(id) { return this.marketListings.get(id) || null; }

  // -- Couriers --
  upsertCourier(courier) { this.couriers.set(courier.id, courier); }
  getCourierById(id) { return this.couriers.get(id) || null; }
  getMovingCouriers() {
    const result = [];
    for (const c of this.couriers.values()) {
      if (c.status === 'moving') result.push(c);
    }
    return result;
  }

  // -- Courier drops --
  upsertDrop(drop) { this.courierDrops.set(drop.id, drop); }
  getDropById(id) { return this.courierDrops.get(id) || null; }

  // -- Notifications --
  addNotification(notif) { this.notifications.set(notif.id, notif); }
  markNotificationsRead(ids) {
    for (const id of ids) {
      const n = this.notifications.get(id);
      if (n) n.read = true;
    }
  }

  // -- Clans --
  getClanById(id) { return this.clans.get(id) || null; }
  upsertClan(clan) { this.clans.set(clan.id, clan); }

  // -- Clan members --
  getClanMembers(clanId) {
    const result = [];
    for (const m of this.clanMembers.values()) {
      if (m.clan_id === clanId && !m.left_at) result.push(m);
    }
    return result;
  }
  upsertClanMember(member) { this.clanMembers.set(member.id, member); }

  // -- Clan HQs --
  getClanHqByPlayerId(playerId) {
    for (const ch of this.clanHqs.values()) {
      if (ch.player_id === playerId) return ch;
    }
    return null;
  }
  upsertClanHq(hq) { this.clanHqs.set(hq.id, hq); }

  // -- App settings --
  getSetting(key) { return this.appSettings.get(key) || null; }
  setSetting(key, value) { this.appSettings.set(key, String(value)); }

  // -- Cores --
  getCoresForMine(cellId) {
    const result = [];
    for (const c of this.cores.values()) {
      if (c.mine_cell_id === cellId) result.push(c);
    }
    return result;
  }
  getPlayerCores(playerId) {
    const result = [];
    for (const c of this.cores.values()) {
      if (String(c.owner_id) === String(playerId)) result.push(c);
    }
    return result;
  }
  getPlayerInventoryCores(playerId) {
    return this.getPlayerCores(playerId).filter(c => !c.mine_cell_id);
  }
  upsertCore(core) { this.cores.set(core.id, core); }
  removeCore(id) { this.cores.delete(id); }

  // -- Leaderboard --
  getLeaderboard(limit = 100) {
    const sorted = [...this.players.values()]
      .sort((a, b) => (b.xp || 0) - (a.xp || 0))
      .slice(0, limit);
    return sorted.map((p, i) => ({
      telegram_id: p.telegram_id, username: p.username, game_username: p.game_username,
      avatar: p.avatar, level: p.level, xp: p.xp, rank: i + 1,
    }));
  }
}

// Singleton
export const gameState = new GameState();
