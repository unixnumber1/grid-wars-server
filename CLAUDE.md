# GRID WARS

Telegram Mini App — геолокационная стратегия в реальном мире.

## Стек

| Компонент | Технология |
|-----------|-----------|
| Frontend | `/public/index.html` (единый файл ~860KB), Leaflet.js, Socket.io, MapLibre GL, H3-JS |
| Backend | Express + Socket.io, Node.js 20+ (ESM) |
| БД | PostgreSQL 16 (self-hosted), custom QueryBuilder `lib/supabase.js` (Supabase-compatible API) |
| Хостинг | VPS 138.124.87.99, PM2, Nginx, SSL :8443 |
| Telegram | Bot API + WebApp SDK (HapticFeedback, openInvoice, initData auth) |
| Репо | `github.com/unixnumber1/grid-wars-server.git` |
| Деплой | `git push server master:main` → front-watcher за 30с |

## Env
```
DATABASE_URL=postgresql://overthrow:...@localhost:5432/overthrow_db
BOT_TOKEN=
WEBHOOK_SECRET=
PORT=3000
```

---

## Структура файлов

```
server.js                  — Express + Socket.io + webhook + game loop init (~850 строк)
ecosystem.config.cjs       — PM2 конфиг (grid-wars + front-watcher)

/config
  constants.js             — ВСЕ константы игры (радиусы, лимиты, КД, цены, лут-таблицы)
  formulas.js              — доход, стоимость, HP, XP формулы, HQ конфиг
  badges.js                — определения бейджей, checkAndAwardBadges()
  skills.js                — дерево навыков (raider/farmer), эффекты, способности
  i18n.js                  — локализация ru/en (~170 ключей)
  levelRewards.js          — таблица наград за уровни (50 уровней)

/game
  /state
    GameState.js           — in-memory state (25+ Maps + dirty tracking, ~685 строк)
    persist.js             — batch upsert каждые 30с, persistNow/insertNow/deleteNow
  /loop
    gameLoop.js            — 5с тик: боты, курьеры, зомби, защитники, cleanup
                             1с тик: реген щита монументов + emit
  /mechanics (12 файлов)
    bots.js                — типы ботов (spirit/goblin/werewolf/demon/dragon/boss), дрейн, награды
    clans.js               — уровни кланов, бонусы, зоны
    collectors.js          — автосборщики, уровни, режимы auto/manual
    cores.js               — 4 типа ядер, множители, стоимости апгрейда
    fireTrucks.js          — пожарные машины: тушение, уровни, HP
    items.js               — предметы: статы, генерация, апгрейд формула, крафт
    market.js              — маркет: Overpass спавн, поиск локаций
    monuments.js           — рейд-боссы: волны, защитники, лут (pool + trophyBonus), ядра
    oreNodes.js            — рудники: спавн, типы, извержения, dual currency
    skills.js              — эффекты навыков, способности (shadow/sniper/landlord/teleport/safe)
    vases.js               — вазы: спавн для штабов
    xp.js                  — XP награды, начисление уровней
    zombies.js             — зомби-орды: скауты, волны (10+), боссы, лут

/api
  /middleware
    auth.js                — проверка telegram_id
    validate.js            — валидация запросов
    ban.js                 — проверка бана
  /routes (18 файлов)
    player.js              — init/location/pvp/profile/set-active-badge/set-username/set-avatar
    map.js                 — GET leaderboard / tick state
    buildings.js           — HQ place/upgrade/sell, mine build/upgrade/hit/sell/collect
    items.js               — equip/unequip/sell/craft/upgrade + daily-diamonds + stars-invoice
    market.js              — listings/buy/list-item/cancel/attack-courier/pickup-drop/search-by-code
    bots.js                — attack/spawn
    vases.js               — spawn/break
    clan.js                — build-hq/create/join/leave/donate/upgrade/kick/transfer/boost/disband/edit/apply/accept/reject
    admin.js               — reward/deduct/ban/unban/maintenance/give-item/remove-item/stats/player-search
    monuments.js           — start-raid/attack-shield/attack-monument/attack-defender/open-loot-box/request
    collectors.js          — build/upgrade/deliver/sell/hit/extinguish/set-mode
    ore.js                 — capture/hit/take-dual-currency
    cores.js               — install/uninstall/upgrade/sell/mass-sell/inventory
    shop.js                — star payments (stub, merged into items)
    skills.js              — get-tree/invest/reset/activate-shadow
    zombies.js             — spawn-scout/attack
    fireTrucks.js          — build/upgrade/sell/hit/dispatch/extinguish-self/hit-firefighter
    rewards.js             — get-level-rewards/claim-reward/claim-all

/security
  antispoof.js             — GPS антиспуф v2 (джамминг, джойстики, автобан)
  rateLimit.js             — rate limiting по telegram_id
  telegramAuth.js          — HMAC-SHA256 верификация initData
  validate.js              — валидация telegram_id, координат, XSS

/socket
  events.js                — pushToPlayer, pushToNearby, emitToNearbyPlayers

/lib
  supabase.js              — PostgreSQL QueryBuilder + sendTelegramNotification + rateLimit (~539 строк)
  h3.js                    — H3 hex grid (resolution 10, ~65м гексы)
  grid.js                  — re-export из h3.js
  haversine.js             — расстояние между координатами (метры)
  logger.js                — логирование действий игроков (200 записей/игрок)
  log.js                   — dev-only лог
  format.js                — форматирование чисел (Q/T/B/M/K)

/routes                    — re-exports из api/routes/ (обратная совместимость)

/tests/mechanics
  formulas.test.js         — тесты формул (доход, HP, стоимость)
  cores.test.js            — тесты ядер (множители, стоимость)
  items.test.js            — тесты предметов (генерация, апгрейд)

/scripts
  front-watcher.js         — автодеплой (git pull каждые 30с)
  test-smoke.js            — smoke tests
  wipe-buildings.js        — вайп с компенсацией
  recalc-player-levels.js  — пересчёт уровней
  recalc-items.js          — пересчёт предметов
  recalc-mines.js          — пересчёт HP шахт
  recalc-monuments.js      — пересчёт HP/щитов монументов
  check-player.js          — дебаг данных игрока
  resend-welcome.js        — переотправка welcome-сообщений

/public
  index.html               — единый фронтенд (HTML+CSS+JS, ~860KB)
```

---

## БД (PostgreSQL) — 28 таблиц

| Таблица | Ключевые колонки |
|---------|-----------------|
| `players` | id, telegram_id, game_username, avatar, level, xp, hp, max_hp, coins(BIGINT), diamonds, crystals, ether(BIGINT), clan_id, active_badge, is_banned, ban_until, shield_until, last_lat/lng, daily_diamonds_claimed_at, created_at |
| `headquarters` | id, player_id, lat, lng, cell_id, level(1-10), created_at |
| `mines` | id, owner_id, lat, lng, cell_id, level(1-200), coins, hp, max_hp, status(active/burning/destroyed), pending_level, upgrade_finish_at, last_collected, attacker_id, burning_started_at |
| `items` | id, owner_id, type(sword/axe/shield), rarity, name, emoji, attack, defense, crit_chance, upgrade_level, equipped, on_market |
| `cores` | id, owner_id, core_type(income/capacity/hp/regen), level(0-100), mine_cell_id, slot_index |
| `bots` | id, type, category, lat, lng, spawn_lat/lng, level, speed, hp, status(roaming/attacking/leaving), target_mine_id, drained_amount, drain_per_sec, expires_at |
| `vases` | id, lat, lng, owner_id, expires_at, broken_by |
| `markets` | id, lat, lng, name, cell_id |
| `market_listings` | id, item_id, seller_id, price, code, status(active/sold/expired), expires_at(48h) |
| `couriers` | id, owner_id, current_lat/lng, destination_lat/lng, hp, max_hp, status(moving/delivered/destroyed) |
| `courier_drops` | id, courier_id, owner_id, item_id, core_id, coins, lat, lng, picked_up, expires_at |
| `ore_nodes` | id, lat, lng, cell_id, ore_type(hill/mountain/peak/volcano), level(1-10), hp, owner_id, captured_at, expires_at(30д), erupted, eruption_at |
| `clans` | id, name, symbol, color, leader_id, level(1-10), coins(treasury), created_at |
| `clan_members` | id, clan_id, player_id, role(leader/officer/member), joined_at, left_at |
| `clan_headquarters` | id, clan_id, player_id, lat, lng, cell_id, level |
| `collectors` | id, owner_id, lat, lng, cell_id, level(1-9), coins, hp, status(active/burning/destroyed), mode(auto/manual) |
| `fire_trucks` | id, owner_id, lat, lng, cell_id, level(1-9), hp, status(active/destroyed) |
| `monuments` | id, lat, lng, cell_id, name, emoji, level(1-10), hp, max_hp, shield_hp, max_shield_hp, phase(shield/open/wave/defeated), respawn_at, waves_triggered, created_at |
| `monument_defenders` | id, monument_id, emoji, hp, max_hp, lat, lng, wave, alive |
| `monument_loot_boxes` | id, monument_id, player_id, box_type(trophy/gift), gems, items(JSONB), opened, lat, lng, expires_at(24h) |
| `monument_requests` | id(auto), player_id, lat, lng, name, emoji, level, status(pending/approved/rejected) |
| `zombies` | id, horde_id, player_id, type(scout/normal/boss), emoji, hp, max_hp, lat, lng, speed, alive |
| `zombie_hordes` | id, player_id, wave, status(scout/active/defeated), center_lat/lng, last_attack_at |
| `notifications` | id, player_id, type, message, data(JSONB), read |
| `pvp_log` | id, attacker_id, defender_id, winner_id, rounds, coins_transferred |
| `pvp_cooldowns` | attacker_id, defender_id, expires_at |
| `player_badges` | id, player_id(→telegram_id), badge_id |
| `player_skills` | id, player_id, farmer(JSONB), raider(JSONB), skill_points_used, shadow_until, shadow_cooldown |
| `referrals` | id, referred_id, referrer_id, referred_rewarded, referrer_rewarded |
| `level_rewards_claimed` | id, player_id, level, reward, claimed_at |
| `app_settings` | key, value |

**Важно**: колонка осколков в БД = `crystals` (не `shards`). `shards` — только тип валюты рудника.

---

## Архитектура

### In-Memory Game State (`game/state/GameState.js`)
- **Все чтения** — только из gameState (не из БД)
- 25+ Maps с быстрым lookup (по id, telegram_id, cell_id, player_id)
- Новые объекты → gameState → `markDirty()` → batch persist через 30с
- Критичные операции (деньги, PvP) → `persistNow()` немедленная запись
- `loadFromDB()` при старте (paginated, 1000 rows/request)

### Основные Maps в GameState:
- `players` + `playersByTgId` — игроки (двойной индекс)
- `headquarters` + `hqByPlayerId` — штабы
- `mines` + `mineByCellId` — шахты
- `items`, `cores` — предметы и ядра
- `bots`, `vases`, `zombies`, `zombieHordes` — мобы
- `monuments`, `monumentDefenders`, `monumentDamage`, `activeWaves` — рейды
- `collectors`, `fireTrucks`, `firefighters` (runtime only)
- `markets`, `marketListings`, `couriers`, `courierDrops` — маркет
- `clans`, `clanMembers`, `clanHqs` — кланы
- `oreNodes`, `notifications`, `playerSkills`, `pvpCooldowns`, `appSettings`

### Game Loop (`game/loop/gameLoop.js`)
**Основной тик (5с):**
1. Движение ботов (каждые 8с): aggro к шахтам, дрейн, бегство
2. Движение курьеров → доставка
3. Движение пожарных → тушение
4. Движение защитников монументов → атака игроков
5. Движение зомби + timeout check (каждые ~1мин)
6. Periodic cleanup (каждые 5мин): expired bots, dead zombies
7. Broadcast state каждому подключённому игроку (emit `tick`)

**Отдельный тик (1с):**
- Реген щита монументов (MONUMENT_SHIELD_REGEN_PER_SEC) + emit `monument:shield_update`

**Persist (30с):**
- Dirty objects → upsert в БД

### Боевая система
- POST → сервер считает урон → Socket.io emit снаряда
- КД оружия: sword 500ms, axe 700ms, без оружия 200ms
- Урон: `(10 + weapon_attack) × (0.8-1.2)` + крит бонус
- `lastAttackTime` Map — rate limit атак per player

### server.js ключевые exports
- `connectedPlayers` — Map<socketId, {telegram_id, lat, lng, lastState}>
- `pendingReferrals` — Map<newPlayerId, referrerId>
- `lastAttackTime` — Map<tgId, timestamp>
- `io`, `gameState`

---

## Игровые механики

### Зоны
- **200м** (SMALL_RADIUS): строить, улучшать, собирать, вазы
- **500м** (LARGE_RADIUS): атаковать ботов, PvP, атаковать шахты

### Валюты
| Валюта | БД колонка | Источник | Использование |
|--------|-----------|---------|--------------|
| Монеты | coins (BIGINT) | Шахты, PvP | Постройки, улучшения, клан |
| Алмазы | diamonds | Боксы, вазы, daily, Stars, уровни | Сборщики, маркет, клан, скиллы |
| Осколки | crystals | Рудники (hill/mountain=shards, peak/volcano=оба) | Прокачка оружия |
| Эфир | ether (BIGINT) | Рудники (hill/mountain=ether, peak/volcano=оба) | Прокачка ядер |

### Шахты (mines)
- Уровень 1-200, доход: `50 * level^2` монет/час
- Вместимость: доход × hours (6ч до lv50, до 480ч на lv200+)
- HP: `500 * level^1.3`, реген 25%/ч
- Статусы: active → burning (24ч) → destroyed
- Апгрейд стоимость: `998 * 1.1301^(l-1)` для l≤100
- Буст от количества: +0.1% за каждую шахту в 20км (1000 шахт = x2)
- Постройка в координаты тапа (не центр гекса), cell_id вычисляется

### Штаб (headquarters)
- 10 уровней, бесплатная постройка
- Апгрейд: [0, 1K, 10K, 100K, 1M, 10M, 100M, 1B, 10B, 100B]
- Макс шахт: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
- Макс уровень шахт: [25, 50, 75, 100, 125, 150, 175, 200, 200, 200]
- Лимит монет: [1M, 10M, 100M, 1B, 10B, 100B, 1T, 10T, 100T, 1Q]

### Ядра (`game/mechanics/cores.js`)
- 4 типа: income, capacity, hp, regen
- 10 слотов на шахту, множители аддитивные
- Множитель: `1 + level × 0.49` (lv0=x1, lv50=x25.5, lv100=x50)
- Апгрейд за эфир: 100→53000 за уровень (границы ≤10/25/50/75/90)
- Дроп с монументов: 10-95% шанс, 1-5 ядер по уровню

### Предметы (`game/mechanics/items.js`)
- 3 типа: sword (attack+crit, КД 0.5с), axe (attack×1.4, КД 0.7с), shield (defense+block)
- 6 редкостей: common → uncommon → rare → epic → mythic → legendary
- Базовые статы (фиксированные):
  - Sword: 20/50/110/220/380/580 atk, 3/5/8/12/16/20% crit
  - Axe: 28/70/150/300/520/800 atk
  - Shield: 100/250/550/1100/3800/5800 def
- Апгрейд: `base × (1 + level × 0.09)` — x10 на lv100
- Crit_chance НЕ масштабируется с уровнем
- Макс уровень апгрейда: common=10, uncommon=25, rare=50, epic=75, mythic=90, legendary=100
- Крафт: 10 одной редкости → 1 следующей

### Рудники (`game/mechanics/oreNodes.js`)
- 4 типа: hill (50%), mountain (30%), peak (15%), volcano (5%)
- Уровни: hill 1-4, mountain 3-7, peak 5-9, volcano 8-10
- Доход множитель: hill=1x, mountain=1.5x, peak=2.5x, volcano=4x
- HP: hpBase + level × hpPerLevel (от 1500 до 25000)
- Dual currency: peak и volcano дают осколки И эфир
- Захват: сломать HP → claim. Min 500м между рудниками
- Извержения вулканов: 0%→90% за 20 дней владения
- Спавн: Overpass API, min(max(10, online×8), 150) на город
- TTL: 30 дней

### Боты (`game/mechanics/bots.js`)
- Типы: spirit, goblin, werewolf, demon, dragon, boss
- Скорости: slow(15м/с), medium(30), fast(55), very_fast(90)
- Дрейн лимиты: spirit=50, goblin=50K, werewolf=400, demon=1K, dragon=3K, boss=10K
- TTL: 5 минут, 10 на зону
- Цикл: roaming → aggro (500м к шахте) → attacking → fleeing

### Зомби (`game/mechanics/zombies.js`)
- Scout: HP 30, speed 1.5м/с → убит → wave 1
- Волны: [5,10,15,25,40,55,70,90,120,150], потом +20/волну
- Босс каждые 5 волн (wave/5 боссов)
- HP зомби: 100 + (wave-1)×500, босс: (wave/5)×5000
- Формации: cluster, line, two_sides, three_sides, surround, chaos
- Таймаут: 5 мин без атак → despawn

### Монументы (`game/mechanics/monuments.js`)
- Создание: заявка от игрока → одобрение админа в Telegram
- 10 уровней: HP 50K→40M, щит 8K→10M
- Фазы: shield → open → wave → defeated (7 дней респавн)
- **Реген щита**: [500, 1000, 1500, 2000, 3000, 4000, 7000, 10500, 15000, 17000] HP/сек
- Волны: 3 триггера на 75%, 50%, 25% HP
- Защитники: HP 200→17500, атака 40→1360 по уровням
- **Лут (pool система)**: общий пул предметов делится пропорционально урону
  - Пул: [5 rare ... 13 epic + 2 mythic + 1 legendary(15%)] по уровням
  - trophyBonus: +1 предмет повышенной редкости для топ-1 по урону
  - Гемы: один бросок (40-1000 по уровню), делятся по вкладу
  - Ядра: 10-95% шанс, 1-5 штук, топ-1 гарантирован минимум 1
- XP при открытии бокса: `monumentLevel × 100000`

### PvP
- Радиус: 500м, реалтайм удары
- Щит 2мин после смерти
- Проигравший теряет 10% монет → 50% победителю (50% уничтожается)
- Скилл Safe: 5% потерь вместо 10%

### Кланы
- Штаб: 10М монет
- 10 уровней: макс участников [5→50], апгрейд за алмазы [2K→234K]
- Роли: leader, officer, member
- Буст дохода: x2-x6.5 на 24ч за алмазы из казны
- Leave cooldown: 72ч
- Автопередача лидерства при 7д неактивности

### Автосборщики (collectors)
- Стоимость: 50💎, 9 уровней, апгрейд за алмазы [20→225💎]
- Радиус: 200м, автосбор с шахт
- Режимы: auto (фоновый), manual (кнопка доставки)
- Комиссия: 0% (отключена)
- PvP: уничтожение → монеты атакующему

### Пожарные машины (`game/mechanics/fireTrucks.js`)
- Стоимость: 75💎, 9 уровней (радиус 200-600м, HP 2K-60K)
- Доступны: HQ lv5 (1 шт), HQ lv10 (2 шт)
- Тушат: горящие шахты, сборщики, другие машины
- Стоимость тушения: 5% от total upgrade cost шахты
- Анимация пожарного от машины к цели

### Навыки (`config/skills.js`)
- 2 дерева: RAIDER (бой), FARMER (экономика)
- 5 макс уровень на блок, 1 поинт = 1 уровень
- Сброс: 10💎 за поинт
- **RAIDER**: Damage(+0.8%/lv), Crit(+0.4%), Speed(+1%), Vitality(+0.8% HP), Vampire(+0.3% lifesteal), Destroyer(+0.8% PvE), Marauder(+1% PvP loot), Hunter(+2м радиус)
  - Способности: Shadow (30мин невидимость, 24ч КД), Sniper (первый удар всегда крит)
- **FARMER**: Income(+1%), Capacity(+1%), Coverage(+1% радиус), Durability(+1% HP), Regen(+1%), Defender(+0.67% dmg reduction), Territory(+1м), Gatherer(+1% ore)
  - Способности: Landlord (+15% доход 200м пока онлайн), Teleport (мгновенная доставка), Safe (5% потерь при PvP)

### XP система (`config/formulas.js`)
- Формула: `800 × 15^phase × n^2.15`, phase = floor((level-1)/100), n = ((level-1)%100)+1
- Century multipliers: [1, 1.38, 3.82, 10.34, 22.71, 37.06, 75.09, 160.16, 354.96]
- Уровень не ограничен
- XP за сбор: 10% шанс, 0.1-1% от монет
- Награды: config/levelRewards.js (алмазы, осколки, эфир, боксы, ядра)

### PIN-режим
- Телепорт на HQ, GPS игнорируется, сессия 1 час
- HQ старше 24ч, пин ≤20км
- Кнопка показывает оставшееся время

### Бейджи (`config/badges.js`)
- `player_badges` таблица, `active_badge` на players
- Автовыдача через `checkAndAwardBadges()`
- Socket event `badge:earned`
- Pioneer: игроки с created_at < 2026-04-01

### Реферальная система
- Ссылка: `https://t.me/OverthrowGamebot?start=ref_<tgId>`
- Приглашённый: 50💎 при постройке HQ
- Пригласивший: 50💎 + 100💎 когда реферал достигнет lv50

### Маркет
- Торговля предметами и ядрами, 10% комиссия
- Автоспавн рынков через Overpass API (5км от игрока)
- Листинги: макс 10 на игрока, TTL 48ч
- Курьеры на карте, PvP перехват
- Ядра продаются мгновенно (без курьера)

---

## UI (Frontend)

### Тема
- Тёмная: bg #0d0d0d, cards #1a1a2e/#252538, gold #FFD700, green #00E676
- Segoe UI / system-ui, glassmorphism (backdrop-filter: blur)
- Кнопки: radius 12px, border 1px solid

### Экраны и Z-Index
| Z-Index | Элемент |
|---------|---------|
| 99999 | username-setup, maintenance-screen |
| 20000 | death-screen |
| 10000 | admin-player-modal |
| 9999 | pvp-overlay, ban-screen, loading |
| 9998 | toast-container, box-odds-popup |
| 9100 | core-detail-overlay |
| 9000 | popup-overlay (bottom sheet) |
| 7500 | monument-worldmap-overlay (MapLibre globe) |
| 6000 | change-username-overlay |
| 5600 | avatar-sheet-overlay |
| 5500 | settings-drawer |
| 5200 | shop-modal |
| 5100 | profile-overlay |
| 5000 | leaderboard-overlay |
| 3600 | market-list-overlay |
| 3300 | profile-modal (inventory) |
| 1500 | mine-attack-overlay |
| 1000 | hud-top-pill, hud-right-panel, bottom-panel |

### Навигация
- **Хедер**: монеты × доход/ч | алмазы | осколки | эфир
- **Правая панель**: PIN, магазин, рынок, лидерборд, настройки
- **Низ**: аватар + ник/уровень/XP бар + кнопка Собрать

### Инвентарь (profile-modal)
- Вкладки: Снаряжение / Ядра / Награды / Навыки / Бейджи
- Снаряжение: сетка 4 колонки, mass sell, крафт
- Ядра: сетка 4 колонки, тап → попап с прокачкой

### Leaflet Z-Index маркеров
- 10000: Игрок | 4500: Зомби-боссы | 4000: Боты, курьеры, защитники, пожарные
- 3000: Монументы, рынки | 2000: Рудники, сборщики | 1000: Шахты, штабы, лутбоксы

### Hex сетка
- Flash по тапу в зоне 200м, затухание за 1с
- Тап на пустую клетку → меню постройки
- Свободные: контур; занятые: серая заливка

---

## Socket Events

### Client → Server
- `player:init` — подключение + initData верификация
- `player:location` — обновление позиции (antispoof)

### Server → Client (tick)
```
tick: { headquarters, mines, bots, vases, online_players, couriers, courier_drops,
        markets, clan_hqs, ore_nodes, collectors, monuments, monument_defenders,
        fire_trucks, firefighters }
```

### Push Events
- `player:moved`, `player:died`, `player:respawned`
- `projectile`, `pvp:hit`, `pvp:kill`
- `mine:hp_update`, `ore:captured`, `ore:hp_update`, `ore:broken`, `ore:eruption`
- `monument:shield_update`, `monument:shield_broken`, `monument:shield_restored`
- `monument:wave_spawn`, `monument:wave_started`, `monument:wave_cleared`
- `monument:hp_update`, `monument:defeated`, `monument:loot_dropped`, `monument:defender_killed`
- `collector:hp_update`, `collector:burning`, `core:dropped`
- `firetruck:hp_update`, `firetruck:burning`
- `firefighter:spawned`, `firefighter:hp_update`, `firefighter:killed`, `firefighter:arrived`, `firefighter:removed`
- `zombie:scout_spawned`, `zombie:horde_started`, `zombie:wave_spawned`, `zombie:wave_cleared`
- `zombie:killed`, `zombie:removed`, `zombie:remove_all`, `zombie:move_batch`, `zombie:horde_timeout`, `zombie:attack_player`
- `courier:removed`
- `badge:earned`

---

## Безопасность

### Telegram initData (`security/telegramAuth.js`)
- HMAC-SHA256 верификация через `X-Telegram-Init-Data` заголовок
- Верифицированный telegram_id перезаписывает req.body.telegram_id
- Без initData — пропуск (backward compat), с невалидной — 403
- Максимальный возраст: 24ч

### GPS антиспуф (`security/antispoof.js`)
- Лимит скорости: 200 км/ч (250 cross-session)
- Джамминг: прыжок >500м за <5с → adaptive cooldown (60с→5мин)
- Джойстики: jitter <2м, speed tolerance <3%, score cap 80, при ≥60 → нарушение
- GPS instability score (0-100): >30 = double threshold, >60 = suppress violations
- Автобан: weighted score ≥15 → 30 дней + уведомление админу
- Админ (ADMIN_TG_ID=560013667) не проверяется

### Rate limiting (`security/rateLimit.js`)
| Тип | Лимит/мин |
|-----|-----------|
| tick | 60 |
| location | 400 |
| attack | 300 |
| build | 80 |
| collect | 120 |
| market | 120 |
| default | 240 |

### Express middleware chain
1. Security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
2. CORS (wildcard)
3. JSON body parser (100kb limit)
4. validateRequest
5. verifyTelegramAuth (для /api/**)
6. checkBan
7. rateLimit по типу роута

---

## Деплой

### Маршрут
1. Редактировать локально
2. Backup БД: `ssh root@138.124.87.99 /root/backup-db.sh`
3. `git add . && git commit && git push server master:main`
4. front-watcher подхватит за 30с, pm2 restart при изменении бэкенда

### Запрещено
- Копировать файлы через SCP (front-watcher затрёт)
- Редактировать на VPS напрямую
- `pm2 restart all` (ломает front-watcher, использовать `pm2 restart grid-wars`)

### Бэкапы
- Автоматический backup каждые 6 часов (`/root/backup-db.sh`)
- Хранение 7 дней: `/root/backups/db_YYYYMMDD_HH.sql.gz`

---

## Админ
- ADMIN_TG_ID: 560013667
- Джойстик перемещения (3 скорости)
- Fullscreen менеджер игроков: поиск → инвентарь/ресурсы/бан/логи
  - Инвентарь: просмотр, выдача предметов (тип/редкость/уровень), забирание
  - Ресурсы: начисление и списание (coins/diamonds/crystals/ether), выдача ядер
  - Бан: быстрые кнопки 1д/7д/14д/30д/∞, причина, разбан
  - Логи: действия с фильтрами по типу
- Панель: maintenance, spawn vases/zombies, server stats (uptime/RAM/CPU), online graph
- Webhook: одобрение/отклонение монументов, бан подтверждение
- Referral leaderboard

---

## Железные правила

### 1. Роут не содержит бизнес-логику
Роут вызывает механику, механика возвращает результат.

### 2. Все чтения из gameState
Никогда `await supabase.from('...').select()` для чтения — только `gameState.mines.get(id)`.

### 3. Константы только в config/constants.js
Не хардкодить числа в роутах или механиках.

### 4. Новая механика = новый файл в game/mechanics/

### 5. Новая постройка/предмет = запись в config/

### 6. После изменений запускать тесты
```
node --test tests/mechanics/*.test.js
```

### 7. Деплой только через git push

### 8. upgrade_level всегда включать при SELECT/UPDATE items

### 9. Постройки ставятся в координаты тапа (не центр гекса)

### 10. Паттерн эндпоинтов: gameState → emit → markDirty

### 11. Критичные операции (деньги, PvP) → немедленная запись в БД через persistNow()

### 12. Runtime-only поля на gameState — префикс `_` (не попадают в persist)

### 13. БД колонка осколков = `crystals` (не `shards`)
