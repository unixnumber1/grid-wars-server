import { supabase } from '../../lib/supabase.js';
import { computeMineBoostData } from '../../lib/mineBoost.js';
import { calcMineHpRegen, getHqBoostRadius } from '../../config/formulas.js';

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
    this.fireTrucks = new Map();     // id -> full row
    this.firefighters = new Map();   // id -> runtime only (no DB)
    this.monuments = new Map();      // id -> full row
    this.monumentDefenders = new Map(); // id -> full row
    this.monumentDamage = new Map(); // monument_id -> Map(player_id -> damage)
    this.cores = new Map();            // id -> full row
    this.zombieHordes = new Map();   // id -> full row
    this.zombies = new Map();        // id -> full row
    this.activeWaves = new Map();    // monument_id -> { wave_number, last_wave_at, last_attack_at }
    this.barracks = new Map();       // id -> full row
    this.trainingQueue = new Map();  // id -> full row
    this.unitBag = new Map();        // id -> full row
    this.unitUpgrades = new Map();   // "tgId_unitType" -> { owner_id, unit_type, level }
    this.activeScouts = new Map();   // id -> full row
    this.appSettings = new Map();   // key -> value (string)
    this.pvpCooldowns = [];         // array of {attacker_id, defender_id, expires_at}
    this.pvpLog = new Map();        // id -> full row
    this.playerSkills = new Map();  // telegram_id (number) -> skill row

    // ── Performance indexes ──
    this._tickVersion = 0;                    // incremented each game loop tick
    this._bestMineLevelByPlayer = new Map();  // player_id -> max mine level (cached)
    this._coresByMineCellId = new Map();      // mine_cell_id -> core[] (secondary index)
    this._itemsByOwnerId = new Map();         // owner_id -> item[] (secondary index)
    this._minesByOwnerId = new Map();           // owner_id -> mine[] (secondary index)
    this._occupiedCells = new Set();          // cell_ids with buildings (for fast isCellFree)
    this._occupiedCellsDirty = true;           // rebuild on first use
    this._mineBoostCache = new Map();         // playerId -> { hash, data: computeMineBoostData result }

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
      fireTrucks: new Set(),
      monuments: new Set(),
      cores: new Set(),
      zombieHordes: new Set(),
      zombies: new Set(),
      barracks: new Set(),
      trainingQueue: new Set(),
      unitBag: new Set(),
      unitUpgrades: new Set(),
      activeScouts: new Set(),
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
    const [players, hqs, mines, bots, vases, items, markets, listings, couriers, drops, notifications, clans, members, clanHqs, settings, pvpCd, pvpLog, oreNodes, collectors, monuments, monumentDefs, cores, zHordes, zZombies, pSkills, fireTrucks, barracksRows, trainingRows, unitBagRows, unitUpgradeRows, activeScoutRows] = await Promise.all([
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
      this._loadAll('zombie_hordes', q => q.in('status', ['scout', 'active'])),
      this._loadAll('zombies', q => q.eq('alive', true)),
      this._loadAll('player_skills'),
      this._loadAll('fire_trucks'),
      this._loadAll('barracks'),
      this._loadAll('training_queue', q => q.eq('collected', false)),
      this._loadAll('unit_bag'),
      this._loadAll('unit_upgrades'),
      this._loadAll('active_scouts'),
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
      // Owner index
      let ownerArr = this._minesByOwnerId.get(m.owner_id);
      if (!ownerArr) { ownerArr = []; this._minesByOwnerId.set(m.owner_id, ownerArr); }
      ownerArr.push(m);
    }
    // Simple maps
    for (const b of (bots || []))          this.bots.set(b.id, b);
    for (const v of (vases || []))         this.vases.set(v.id, v);
    for (const i of (items || []))         this.items.set(i.id, i);
    // Dedup equipped items: only 1 weapon (sword/axe/bow) and 1 shield per player
    this._dedupEquippedItems();
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
    for (const m of (monuments || [])) {
      // Strip runtime fields that leaked into older rows
      delete m.wave_started_at;
      delete m.wave_shield_hp;
      // Restore pending level for defeated monuments (runtime-only, lost on restart)
      if (m.phase === 'defeated') {
        m._pending_level = m.level >= 10 ? 1 : m.level + 1;
        // Fix orphaned defeated monuments missing respawn_at
        if (!m.respawn_at) {
          const RESPAWN_H = [0, 24, 48, 72, 96, 120, 144, 168, 192, 216, 24];
          const hours = RESPAWN_H[m.level] || 168;
          m.respawn_at = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
          this._dirty.monuments.add(m.id);
        }
      }
      this.monuments.set(m.id, m);
    }
    for (const d of (monumentDefs || []))this.monumentDefenders.set(d.id, d);
    for (const c of (cores || []))      this.cores.set(c.id, c);
    for (const h of (zHordes || []))   this.zombieHordes.set(h.id, h);
    for (const z of (zZombies || []))  this.zombies.set(z.id, z);
    for (const s of (pSkills || [])) {
      this.playerSkills.set(Number(s.player_id), s);
    }
    // Restore shadow ability state from persisted skill rows
    const nowMs = Date.now();
    for (const [tgId, skillRow] of this.playerSkills) {
      if (skillRow.shadow_until && skillRow.shadow_until > nowMs) {
        const player = this.getPlayerByTgId(tgId);
        if (player) {
          player._shadow_until = skillRow.shadow_until;
          player._shadow_cooldown = skillRow.shadow_cooldown || 0;
        }
      }
    }
    for (const ft of (fireTrucks || [])) this.fireTrucks.set(ft.id, ft);
    for (const b of (barracksRows || [])) this.barracks.set(b.id, b);
    for (const t of (trainingRows || [])) this.trainingQueue.set(t.id, t);
    for (const u of (unitBagRows || [])) this.unitBag.set(u.id, u);
    for (const u of (unitUpgradeRows || [])) this.unitUpgrades.set(`${Number(u.owner_id)}_${u.unit_type}`, u);
    for (const s of (activeScoutRows || [])) this.activeScouts.set(s.id, s);

    // Sanity: hp<=0 must imply burning (matches attack-handler transition).
    // Heals legacy rows where the burning transition never ran, otherwise
    // autoCollectAll / HP regen / firefighters all silently skip them forever.
    {
      const nowISOFix = new Date().toISOString();
      let zombieFix = 0;
      for (const c of this.collectors.values()) {
        if ((c.hp || 0) <= 0 && c.status === 'normal') {
          c.status = 'burning';
          c.burning_started_at = nowISOFix;
          this._dirty.collectors.add(c.id);
          zombieFix++;
        }
      }
      for (const t of this.fireTrucks.values()) {
        if ((t.hp || 0) <= 0 && t.status === 'normal') {
          t.status = 'burning';
          t.burning_started_at = nowISOFix;
          this._dirty.fireTrucks.add(t.id);
          zombieFix++;
        }
      }
      for (const b of this.barracks.values()) {
        if ((b.hp || 0) <= 0 && b.status === 'normal') {
          b.status = 'burning';
          b.burning_started_at = nowISOFix;
          this._dirty.barracks.add(b.id);
          zombieFix++;
        }
      }
      if (zombieFix) console.log(`[gameState] Fixed ${zombieFix} zombie buildings (hp=0 status=normal → burning)`);
    }

    // ── Build performance indexes ──
    this._rebuildAllIndexes();

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
      fireTrucks: this.fireTrucks.size,
      monuments: this.monuments.size,
      cores: this.cores.size,
      barracks: this.barracks.size,
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

  getDirtySnapshot() {
    const result = {};
    for (const [key, set] of Object.entries(this._dirty)) {
      if (set.size > 0) result[key] = [...set];
    }
    return result;
  }

  clearDirty(collection, ids) {
    const set = this._dirty[collection];
    if (set) for (const id of ids) set.delete(id);
  }

  // ── Performance indexes ──────────────────────────────────────

  _rebuildAllIndexes() {
    // bestMineLevelByPlayer
    this._bestMineLevelByPlayer.clear();
    for (const m of this.mines.values()) {
      if (m.status === 'destroyed' || !m.owner_id) continue;
      const cur = this._bestMineLevelByPlayer.get(m.owner_id) || 0;
      if (m.level > cur) this._bestMineLevelByPlayer.set(m.owner_id, m.level);
    }
    // coresByMineCellId
    this._coresByMineCellId.clear();
    for (const c of this.cores.values()) {
      if (!c.mine_cell_id) continue;
      const arr = this._coresByMineCellId.get(c.mine_cell_id);
      if (arr) arr.push(c); else this._coresByMineCellId.set(c.mine_cell_id, [c]);
    }
    // itemsByOwnerId
    this._itemsByOwnerId.clear();
    for (const i of this.items.values()) {
      if (!i.owner_id) continue;
      const arr = this._itemsByOwnerId.get(i.owner_id);
      if (arr) arr.push(i); else this._itemsByOwnerId.set(i.owner_id, [i]);
    }
    // occupiedCells
    this._occupiedCells.clear();
    for (const m of this.mines.values()) { if (m.cell_id && m.status !== 'destroyed') this._occupiedCells.add(m.cell_id); }
    for (const h of this.headquarters.values()) { if (h.cell_id) this._occupiedCells.add(h.cell_id); }
    for (const c of this.collectors.values()) { if (c.cell_id) this._occupiedCells.add(c.cell_id); }
    for (const ch of this.clanHqs.values()) { if (ch.cell_id) this._occupiedCells.add(ch.cell_id); }
    for (const m of this.monuments.values()) { if (m.cell_id) this._occupiedCells.add(m.cell_id); }
    for (const ft of this.fireTrucks.values()) { if (ft.cell_id && ft.status !== 'destroyed') this._occupiedCells.add(ft.cell_id); }
    for (const b of this.barracks.values()) { if (b.cell_id) this._occupiedCells.add(b.cell_id); }
  }

  // Mark occupiedCells for rebuild (call after adding/removing buildings)
  _invalidateOccupiedCells() { this._occupiedCellsDirty = true; }

  // Fast O(1) cell occupation check (auto-rebuilds if dirty)
  isCellOccupied(cellId) {
    if (this._occupiedCellsDirty) {
      this._occupiedCells.clear();
      for (const m of this.mines.values()) { if (m.cell_id && m.status !== 'destroyed') this._occupiedCells.add(m.cell_id); }
      for (const h of this.headquarters.values()) { if (h.cell_id) this._occupiedCells.add(h.cell_id); }
      for (const c of this.collectors.values()) { if (c.cell_id) this._occupiedCells.add(c.cell_id); }
      for (const ch of this.clanHqs.values()) { if (ch.cell_id) this._occupiedCells.add(ch.cell_id); }
      for (const m of this.monuments.values()) { if (m.cell_id) this._occupiedCells.add(m.cell_id); }
      for (const ft of this.fireTrucks.values()) { if (ft.cell_id && ft.status !== 'destroyed') this._occupiedCells.add(ft.cell_id); }
      for (const b of this.barracks.values()) { if (b.cell_id) this._occupiedCells.add(b.cell_id); }
      this._occupiedCellsDirty = false;
    }
    return this._occupiedCells.has(cellId);
  }

  // Index-based core lookup — O(1) vs O(n)
  getCoresForMineFast(cellId) {
    return this._coresByMineCellId.get(cellId) || [];
  }

  // Index-based items lookup — O(1) vs O(n)
  getItemsByOwner(ownerId) {
    return this._itemsByOwnerId.get(ownerId) || [];
  }

  getEquippedItems(ownerId) {
    return this.getItemsByOwner(ownerId).filter(i => i.equipped);
  }

  // Fix DB corruption: ensure at most 1 weapon + 1 shield equipped per player
  _dedupEquippedItems() {
    // Group equipped items by owner
    const byOwner = new Map();
    for (const item of this.items.values()) {
      if (!item.equipped) continue;
      if (!byOwner.has(item.owner_id)) byOwner.set(item.owner_id, []);
      byOwner.get(item.owner_id).push(item);
    }
    for (const [ownerId, equipped] of byOwner) {
      const weapons = equipped.filter(i => i.type === 'sword' || i.type === 'axe' || i.type === 'bow');
      const shields = equipped.filter(i => i.type === 'shield');
      if (weapons.length > 1) {
        // Keep the one with highest attack, unequip rest
        weapons.sort((a, b) => (b.attack || 0) - (a.attack || 0));
        for (let i = 1; i < weapons.length; i++) {
          weapons[i].equipped = false;
          this.markDirty('items', weapons[i].id);
        }
        console.log(`[dedup] Player ${ownerId}: unequipped ${weapons.length - 1} extra weapons`);
      }
      if (shields.length > 1) {
        shields.sort((a, b) => (b.defense || 0) - (a.defense || 0));
        for (let i = 1; i < shields.length; i++) {
          shields[i].equipped = false;
          this.markDirty('items', shields[i].id);
        }
        console.log(`[dedup] Player ${ownerId}: unequipped ${shields.length - 1} extra shields`);
      }
    }
  }

  // Update bestMineLevel cache on mine change
  _updateBestMineLevel(playerId) {
    if (!playerId) return;
    let best = 0;
    for (const m of this.mines.values()) {
      if (m.owner_id === playerId && m.status !== 'destroyed' && m.level > best) best = m.level;
    }
    if (best > 0) this._bestMineLevelByPlayer.set(playerId, best);
    else this._bestMineLevelByPlayer.delete(playerId);
  }

  // Update core index on core change
  _updateCoreIndex(core, removing) {
    if (!core.mine_cell_id) return;
    const cellId = core.mine_cell_id;
    if (removing) {
      const arr = this._coresByMineCellId.get(cellId);
      if (arr) {
        const idx = arr.indexOf(core);
        if (idx !== -1) arr.splice(idx, 1);
        if (arr.length === 0) this._coresByMineCellId.delete(cellId);
      }
    } else {
      const arr = this._coresByMineCellId.get(cellId);
      if (arr) { if (!arr.includes(core)) arr.push(core); }
      else this._coresByMineCellId.set(cellId, [core]);
    }
  }

  // Update item index on item change
  _updateItemIndex(item, removing) {
    if (!item.owner_id) return;
    const ownerId = item.owner_id;
    if (removing) {
      const arr = this._itemsByOwnerId.get(ownerId);
      if (arr) {
        const idx = arr.indexOf(item);
        if (idx !== -1) arr.splice(idx, 1);
        if (arr.length === 0) this._itemsByOwnerId.delete(ownerId);
      }
    } else {
      const arr = this._itemsByOwnerId.get(ownerId);
      if (arr) { if (!arr.includes(item)) arr.push(item); }
      else this._itemsByOwnerId.set(ownerId, [item]);
    }
  }

  // ── Lightweight tick snapshot (only collections needed by socket tick) ──

  getTickSnapshot(n, s, e, w, nowMs) {
    const nowISO = new Date(nowMs).toISOString();

    // Bots in bbox (not expired)
    const bots = [];
    for (const b of this.bots.values()) {
      if (new Date(b.expires_at).getTime() <= nowMs) continue;
      if (b.lat >= s && b.lat <= n && b.lng >= w && b.lng <= e) bots.push(b);
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
        const item = d.item_id ? this.items.get(d.item_id) : null;
        const core = d.core_id ? this.cores.get(d.core_id) : null;
        const courier = this.couriers.get(d.courier_id);
        courier_drops.push({
          ...d,
          coins: d._coins || d.coins || 0,
          owner_id: d.owner_id || (courier ? courier.owner_id : null),
          items: item ? { name: item.name, emoji: item.emoji, rarity: item.rarity, type: item.type, attack: item.attack, crit_chance: item.crit_chance, defense: item.defense } : null,
          core_info: core ? { core_type: core.core_type, level: core.level } : null,
          couriers: courier ? { owner_id: courier.owner_id } : null,
        });
      }
    }

    // Monuments in bbox
    const monuments = [];
    for (const m of this.monuments.values()) {
      if (m.lat >= s && m.lat <= n && m.lng >= w && m.lng <= e) {
        monuments.push({
          id: m.id, lat: m.lat, lng: m.lng, level: m.level, name: m.name, emoji: m.emoji || '🏛️',
          hp: m.hp, max_hp: m.max_hp,
          shield_hp: m.shield_hp, max_shield_hp: m.max_shield_hp,
          wave_shield_hp: m._wave_shield_hp || 0,
          phase: m.phase, raid_started_at: m.raid_started_at,
          respawn_at: m.respawn_at,
          next_level: m._pending_level || null,
        });
      }
    }

    // Monument defenders in bbox (alive only)
    const monument_defenders = [];
    for (const d of this.monumentDefenders.values()) {
      if (!d.alive) continue;
      if (d.lat >= s && d.lat <= n && d.lng >= w && d.lng <= e) {
        monument_defenders.push({
          id: d.id, monument_id: d.monument_id, emoji: d.emoji,
          hp: d.hp, max_hp: d.max_hp, lat: d.lat, lng: d.lng,
        });
      }
    }

    // Active scouts in bbox
    const active_scouts = [];
    for (const s2 of this.activeScouts.values()) {
      const lat = s2.current_lat;
      const lng = s2.current_lng;
      if (lat >= s && lat <= n && lng >= w && lng <= e) {
        active_scouts.push({
          id: s2.id, owner_id: s2.owner_id, lat, lng,
          target_lat: s2.target_lat, target_lng: s2.target_lng,
          speed: s2.speed,
          hp: s2.hp, max_hp: s2.max_hp, level: s2.unit_level,
          status: s2.status, target_ore_id: s2.target_ore_id,
        });
      }
    }

    // Markets in bbox
    const markets = [];
    for (const m of this.markets.values()) {
      if (m.lat >= s && m.lat <= n && m.lng >= w && m.lng <= e) {
        markets.push(m);
      }
    }

    return { bots, vases, couriers, courier_drops, monuments, monument_defenders, active_scouts, markets };
  }

  // -- Spatial queries --
  // Returns objects within bounding box {n, s, e, w}
  getMapSnapshot(n, s, e, w, currentPlayerId, nowMs) {
    const nowISO = new Date(nowMs).toISOString();
    const ONLINE_MS = 3 * 60 * 1000;

    // Use cached best mine level per player (updated on mine upsert/remove)
    const bestMineLevelByPlayer = this._bestMineLevelByPlayer;

    // Resolve "burned_by" display info for a burning building
    const resolveBurnedBy = (obj) => {
      if (!obj || obj.status !== 'burning') return null;
      if (obj._burned_by) return obj._burned_by;
      if (obj.attacker_id) {
        const a = this.players.get(obj.attacker_id);
        if (a) return { telegram_id: a.telegram_id, name: a.game_username || '???', avatar: a.avatar || '🎮' };
      }
      return null;
    };

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
        // Mask attacker_id if attacker is in shadow mode
        const atk = m.attacker_id ? this.players.get(m.attacker_id) : null;
        const atkHidden = atk?._shadow_until && nowMs < atk._shadow_until;
        mines.push({
          ...m,
          attacker_id: atkHidden ? null : m.attacker_id,
          burned_by: atkHidden ? null : resolveBurnedBy(m),
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
      // Shadow ability — hide from other players
      if (p._shadow_until && nowMs < p._shadow_until) continue;
      if (p.last_lat >= s && p.last_lat <= n && p.last_lng >= w && p.last_lng <= e) {
        online_players.push({
          id: p.id, telegram_id: p.telegram_id, username: p.username, game_username: p.game_username,
          avatar: p.avatar, last_lat: p.last_lat, last_lng: p.last_lng, last_seen: p.last_seen,
          level: p.level, shield_until: p.shield_until, bonus_hp: p.bonus_hp, bonus_attack: p.bonus_attack,
          hp: p.hp, max_hp: p.max_hp || 1000,
          active_badge: p.active_badge || null, clan_id: p.clan_id || null,
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
        const item = d.item_id ? this.items.get(d.item_id) : null;
        const core = d.core_id ? this.cores.get(d.core_id) : null;
        const courier = this.couriers.get(d.courier_id);
        courier_drops.push({
          ...d,
          coins: d._coins || d.coins || 0,
          owner_id: d.owner_id || (courier ? courier.owner_id : null),
          items: item ? { name: item.name, emoji: item.emoji, rarity: item.rarity, type: item.type, attack: item.attack, crit_chance: item.crit_chance, defense: item.defense } : null,
          core_info: core ? { core_type: core.core_type, level: core.level } : null,
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
        const isPlaceholder = clan?.name?.startsWith('_placeholder_');
        clan_hqs.push({
          ...ch,
          is_mine: ch.player_id === currentPlayerId,
          is_active: !!ch.clan_id && !isPlaceholder,
          clan_name: isPlaceholder ? null : (clan?.name || null),
          symbol: isPlaceholder ? null : (clan?.symbol || null),
          color: isPlaceholder ? null : (clan?.color || null),
          clan_level: isPlaceholder ? 1 : (clan?.level || 1),
          clans: clan && !isPlaceholder ? { name: clan.name, symbol: clan.symbol, color: clan.color, level: clan.level } : null,
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
          ore_type: o.ore_type || 'hill',
          eruption_phase: o._lastPhase || 'dormant',
          owner_name: owner?.game_username || owner?.username || null,
          owner_avatar: owner?.avatar || null,
          owner_online: owner?.last_seen ? (nowMs - new Date(owner.last_seen).getTime()) < ONLINE_MS : false,
          is_mine: o.owner_id && (o.owner_id === currentPlayerId || String(o.owner_id) === String(currentPlayerId)),
        });
      }
    }

    // Collectors in bbox (with HP regen: 25% maxHP/hour)
    const collectorsArr = [];
    for (const c of this.collectors.values()) {
      if (c.lat >= s && c.lat <= n && c.lng >= w && c.lng <= e) {
        const owner = this.players.get(c.owner_id);
        const canRegen = c.status === 'active' || c.status === 'normal';
        const regenPerHour = canRegen ? Math.floor((c.max_hp || 3000) * 0.25) : 0;
        const hp = (canRegen && c.last_hp_update && c.hp < c.max_hp)
          ? calcMineHpRegen(c.hp, c.max_hp, regenPerHour, c.last_hp_update) : c.hp;
        collectorsArr.push({
          ...c, hp,
          is_mine: c.owner_id === currentPlayerId,
          owner_name: owner?.game_username || owner?.username || null,
          owner_avatar: owner?.avatar || null,
          burned_by: resolveBurnedBy(c),
        });
      }
    }

    // Monuments in bbox
    const monumentsArr = [];
    for (const m of this.monuments.values()) {
      if (m.lat >= s && m.lat <= n && m.lng >= w && m.lng <= e) {
        monumentsArr.push({
          id: m.id, lat: m.lat, lng: m.lng, level: m.level, name: m.name, emoji: m.emoji || '🏛️',
          hp: m.hp, max_hp: m.max_hp,
          shield_hp: m.shield_hp, max_shield_hp: m.max_shield_hp,
          wave_shield_hp: m._wave_shield_hp || 0,
          phase: m.phase, raid_started_at: m.raid_started_at,
          respawn_at: m.respawn_at,
          next_level: m._pending_level || null,
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

    // Fire trucks in bbox (with HP regen: 25% maxHP/hour)
    const fireTrucksArr = [];
    for (const ft of this.fireTrucks.values()) {
      if (ft.status === 'destroyed') continue;
      if (ft.lat >= s && ft.lat <= n && ft.lng >= w && ft.lng <= e) {
        const owner = this.players.get(ft.owner_id);
        const ftCanRegen = ft.status !== 'burning';
        const ftRegenPerHour = ftCanRegen ? Math.floor((ft.max_hp || 2000) * 0.25) : 0;
        const ftHp = (ftCanRegen && ft.last_hp_update && ft.hp < ft.max_hp)
          ? calcMineHpRegen(ft.hp, ft.max_hp, ftRegenPerHour, ft.last_hp_update) : ft.hp;
        fireTrucksArr.push({
          ...ft, hp: ftHp,
          is_mine: ft.owner_id === currentPlayerId,
          owner_name: owner?.game_username || owner?.username || null,
          owner_avatar: owner?.avatar || null,
          burned_by: resolveBurnedBy(ft),
        });
      }
    }

    // Firefighters in bbox (runtime only)
    const firefightersArr = [];
    for (const ff of this.firefighters.values()) {
      if (ff.current_lat >= s && ff.current_lat <= n && ff.current_lng >= w && ff.current_lng <= e) {
        firefightersArr.push(ff);
      }
    }

    // Barracks in bbox (with HP regen: 25% maxHP/hour)
    const barracksArr = [];
    for (const b of this.barracks.values()) {
      if (b.lat >= s && b.lat <= n && b.lng >= w && b.lng <= e) {
        const owner = this.players.get(b.owner_id);
        const bkCanRegen = b.status === 'active';
        const bkRegenPerHour = bkCanRegen ? Math.floor((b.max_hp || 3000) * 0.25) : 0;
        const bkHp = (bkCanRegen && b.last_hp_update && b.hp < b.max_hp)
          ? calcMineHpRegen(b.hp, b.max_hp, bkRegenPerHour, b.last_hp_update) : b.hp;
        barracksArr.push({
          id: b.id, lat: b.lat, lng: b.lng, level: b.level,
          hp: bkHp, max_hp: b.max_hp, status: b.status,
          cell_id: b.cell_id,
          burning_started_at: b.burning_started_at,
          is_mine: b.owner_id === currentPlayerId,
          owner_name: owner?.game_username || owner?.username || null,
          owner_avatar: owner?.avatar || null,
          burned_by: resolveBurnedBy(b),
        });
      }
    }

    // Active scouts in bbox
    const activeScoutsArr = [];
    for (const s2 of this.activeScouts.values()) {
      const lat = s2.current_lat;
      const lng = s2.current_lng;
      if (lat >= s && lat <= n && lng >= w && lng <= e) {
        activeScoutsArr.push({
          id: s2.id, owner_id: s2.owner_id, lat, lng,
          target_lat: s2.target_lat, target_lng: s2.target_lng,
          speed: s2.speed,
          hp: s2.hp, max_hp: s2.max_hp, level: s2.unit_level,
          status: s2.status, target_ore_id: s2.target_ore_id,
        });
      }
    }

    return { headquarters, mines, bots, vases, online_players, couriers, courier_drops, markets: marketsArr, clan_hqs, ore_nodes, collectors: collectorsArr, monuments: monumentsArr, monument_defenders: monumentDefendersArr, fire_trucks: fireTrucksArr, firefighters: firefightersArr, barracks: barracksArr, active_scouts: activeScoutsArr };
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

  // -- Player skills --
  getPlayerSkills(telegramId) {
    return this.playerSkills.get(Number(telegramId)) || { player_id: Number(telegramId), farmer: {}, raider: {}, skill_points_used: 0 };
  }

  // -- Player mines (for income calc) --
  getPlayerMines(playerId) {
    const arr = this._minesByOwnerId.get(playerId);
    if (!arr) return [];
    return arr.filter(m => m.status !== 'destroyed');
  }

  // -- Mine boost data (cached, invalidated on mine build/upgrade/destroy) --
  // Density boost is dual-gated: HQ zone + paid activation. Hash encodes HQ level
  // and the active flag so transitions (activate, expire, upgrade) hit the cache
  // with a new key on the next call.
  getMineBoostData(playerId, clanInfo) {
    const mines = this.getPlayerMines(playerId);
    const hq = this.getHqByPlayerId(playerId);
    const hqInfo = hq ? { lat: hq.lat, lng: hq.lng, radius: getHqBoostRadius(hq.level || 1) } : null;
    const boostActive = !!(hq && hq.boost_expires_at && Date.now() < new Date(hq.boost_expires_at).getTime());
    const hash = mines.length + '_' + mines.reduce((s, m) => s + m.level, 0)
               + '_hq' + (hq ? (hq.id + 'L' + hq.level) : '0')
               + '_b' + (boostActive ? '1' : '0');
    const cached = this._mineBoostCache.get(playerId);
    if (cached && cached.hash === hash) return cached.data;
    const data = computeMineBoostData(mines, clanInfo, hqInfo, boostActive);
    this._mineBoostCache.set(playerId, { hash, data });
    return data;
  }

  invalidateMineBoost(playerId) {
    this._mineBoostCache.delete(playerId);
  }

  // -- Player items (inventory) --
  getPlayerItems(playerId) {
    const items = this._itemsByOwnerId.get(playerId) || [];
    return items.filter(i => !i.on_market && !i.held_by_courier).sort((a, b) => new Date(b.obtained_at) - new Date(a.obtained_at));
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
    const old = this.mines.get(mine.id);
    this.mines.set(mine.id, mine);
    if (mine.cell_id) this.mineByCellId.set(mine.cell_id, mine);
    // Update owner index
    if (old && old.owner_id !== mine.owner_id) {
      const oldArr = this._minesByOwnerId.get(old.owner_id);
      if (oldArr) this._minesByOwnerId.set(old.owner_id, oldArr.filter(m => m.id !== mine.id));
    }
    if (!old || old.owner_id !== mine.owner_id) {
      let arr = this._minesByOwnerId.get(mine.owner_id);
      if (!arr) { arr = []; this._minesByOwnerId.set(mine.owner_id, arr); }
      arr.push(mine);
    } else {
      // Same owner — replace in-place
      const arr = this._minesByOwnerId.get(mine.owner_id);
      if (arr) {
        const idx = arr.findIndex(m => m.id === mine.id);
        if (idx >= 0) arr[idx] = mine; else arr.push(mine);
      }
    }
    this._updateBestMineLevel(mine.owner_id);
    this._occupiedCellsDirty = true;
    this._mineBoostCache.delete(mine.owner_id); // invalidate boost cache
  }
  removeMine(id) {
    const m = this.mines.get(id);
    if (m?.cell_id) this.mineByCellId.delete(m.cell_id);
    this.mines.delete(id);
    if (m?.owner_id) {
      const arr = this._minesByOwnerId.get(m.owner_id);
      if (arr) this._minesByOwnerId.set(m.owner_id, arr.filter(x => x.id !== id));
      this._updateBestMineLevel(m.owner_id);
      this._mineBoostCache.delete(m.owner_id); // invalidate boost cache
    }
    this._occupiedCellsDirty = true;
  }

  // -- HQ --
  getHqByPlayerId(playerId) { return this.hqByPlayerId.get(playerId) || null; }
  upsertHq(hq) {
    this.headquarters.set(hq.id, hq);
    this.hqByPlayerId.set(hq.player_id, hq);
    this._occupiedCellsDirty = true;
  }

  // -- Items --
  getItemById(id) { return this.items.get(id) || null; }
  upsertItem(item) {
    const old = this.items.get(item.id);
    if (old) this._updateItemIndex(old, true);   // always remove old (handles same-ref mutation)
    this.items.set(item.id, item);
    this._updateItemIndex(item, false);
  }
  removeItem(id) {
    const item = this.items.get(id);
    if (item) this._updateItemIndex(item, true);
    this.items.delete(id);
  }

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
  upsertClanHq(hq) { this.clanHqs.set(hq.id, hq); this._occupiedCellsDirty = true; }

  // -- App settings --
  getSetting(key) { return this.appSettings.get(key) || null; }
  setSetting(key, value) { this.appSettings.set(key, String(value)); }

  // -- Cores --
  getCoresForMine(cellId) {
    return this._coresByMineCellId.get(cellId) || [];
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
  upsertCore(core) {
    const old = this.cores.get(core.id);
    if (old && old.mine_cell_id !== core.mine_cell_id) this._updateCoreIndex(old, true);
    this.cores.set(core.id, core);
    this._updateCoreIndex(core, false);
  }
  removeCore(id) {
    const core = this.cores.get(id);
    if (core) this._updateCoreIndex(core, true);
    this.cores.delete(id);
  }

  // -- Leaderboard --
  getLeaderboard(limit = 100) {
    const sorted = [...this.players.values()]
      .sort((a, b) => (b.xp || 0) - (a.xp || 0))
      .slice(0, limit);
    return sorted.map((p, i) => ({
      telegram_id: p.telegram_id, username: p.username, game_username: p.game_username,
      avatar: p.avatar, level: p.level, xp: p.xp, rank: i + 1, active_badge: p.active_badge || null,
    }));
  }
}

// Singleton
export const gameState = new GameState();
