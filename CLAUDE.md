# GRID WARS

Telegram Mini App — геолокационная стратегия в реальном мире.

## Стек
- **Frontend**: `/public/index.html` (единый файл HTML+CSS+JS), Leaflet.js
- **Backend**: Vercel Functions (`/api/*`), Node.js ESM
- **БД**: Supabase (service-role key, RLS off)
- **Хостинг**: Vercel (Hobby, ≤12 functions)
- **Telegram**: Bot API + WebApp SDK
- **URL**: https://grid-wars-two.vercel.app

## Env
```
SUPABASE_URL=
SUPABASE_KEY=
BOT_TOKEN=
```

## Файлы
```
/api
  /player/init.js          — init/set-username/location/pvp-initiate/pvp-flee
  /map/index.js            — GET map data / POST tick (unified polling 5s)
  /buildings/headquarters.js
  /buildings/mine.js
  /buildings/attack.js     — attack/finish/extinguish/sell
  /buildings/upgrade.js
  /economy/collect.js
  /items/index.js          — equip/unequip/sell/open-box/craft/daily-diamonds/daily-check/stars-invoice/webhook
  /market/index.js         — listings/buy/list-item/cancel/attack-courier/pickup-drop/move-couriers
  /bots.js                 — spawn/move/attack/repel/lure
  /vases.js                — spawn/break/cron
  /admin/maintenance.js    — reward/ban/unban/generate-markets/maintenance-start/end/fix-hq/setup-webhook
/lib
  supabase.js  grid.js  haversine.js  income.js  formulas.js  items.js  bots.js  vases.js  xp.js
/public
  index.html
vercel.json  CLAUDE.md
```

## БД (Supabase)

| Таблица | Ключевые колонки |
|---------|-----------------|
| `players` | telegram_id, game_username, avatar, coins(BIGINT), diamonds, level, xp, hp, max_hp, attack, bonus_attack, bonus_crit, bonus_hp, equipped_sword, equipped_shield, shield_until, is_banned, daily_diamonds_claimed_at |
| `headquarters` | player_id, lat, lng, cell_id, level |
| `mines` | owner_id, lat, lng, cell_id, level(0-250), last_collected, hp, max_hp, status(normal/under_attack/burning/destroyed), attacker_id, burning_started_at |
| `items` | player_id, type(sword/axe/shield), rarity, attack, crit_chance, defense, on_market, held_by_courier, held_by_market |
| `bots` | type, category(undead/neutral), emoji, lat, lng, direction, hp, max_hp, attack, speed, expires_at, target_mine_id |
| `vases` | lat, lng, diamonds_reward, expires_at, broken_by |
| `markets` | lat, lng, name |
| `market_listings` | item_id, seller_id, buyer_id, price_diamonds, status, is_private, private_code, expires_at |
| `couriers` | type(to_market/delivery), owner_id, current_lat/lng, dest_lat/lng, hp, status, to_market_id |
| `courier_drops` | item_id, lat, lng, drop_type(loot/delivery), expires_at |
| `notifications` | player_id, type, message, data(JSONB), read |
| `pvp_cooldowns` | attacker_id, defender_id, expires_at |
| `pvp_log` | attacker_id, defender_id, winner_id, rounds(JSONB), coins_transferred |

## Ключевые механики

### Зоны взаимодействия
- **200м** (SMALL_RADIUS): строить/улучшать шахты, собирать монеты, разбивать вазы
- **500м** (LARGE_RADIUS): атаковать ботов, PvP, атаковать чужие шахты

### Экономика
- Шахты 0-250 уровней, формулы в `lib/formulas.js` (getMineUpgradeCost, getMineIncome, getPayback, getMineCapacity)
- Монеты: BIGINT, optimistic locking на все операции
- Алмазы: боксы (5💎/30💎), вазы (1-5💎), ежедневный бонус (5💎), покупка (100💎=15 Telegram Stars)
- Стартовый бонус: 100K монет + 100💎

### Предметы (lib/items.js)
- 3 типа: sword (attack+crit), axe (attack×1.4), shield (defense/HP)
- 6 редкостей: common → uncommon → rare → epic → mythic → legendary
- Крафт: 10 одной редкости → 1 следующей, взвешенный выбор типа
- Экипировка: 1 слот оружия (equipped_sword) + 1 слот щита (equipped_shield)

### Боты (lib/bots.js)
- 5 типов: spirit, goblin, werewolf, demon, dragon
- Глобальный лимит: 20, зона спауна: 500м-2км от игрока
- Undead атакуют шахты (drain монет), neutral — мирные
- Unified tick двигает всех ботов

### Атака построек
- Статусы: normal → under_attack → burning → destroyed
- HP шахт: getMineHp(level), регенерация 25%/ч
- Burning → уничтожение через 24ч, владелец может потушить (25% HP)

### PvP
- 3-раундовый бой, щит 10мин после поражения, кулдаун 30мин
- Проигравший теряет 10% монет, победитель получает 50% от этого

### Маркет
- Торговля предметами за алмазы, 10% комиссия
- Физические точки рынка (OSM), курьеры на карте, PvP перехват курьеров
- Макс 10 листингов, цена 1-100K💎, TTL 48ч

### Unified Tick
- POST /api/map action:tick каждые 5с — заменяет 7+ polling-запросов
- Возвращает: player, buildings, bots, vases, couriers, drops, markets, online_players, notifications
- Периодическая чистка БД каждые 60 тиков (~5мин)

## Оптимизации
- Optimistic locking на coins/diamonds/vases
- Rate limiting: 30 req/min на attack/buy/list-item/lure/repel
- .limit() на все unbounded запросы
- AbortController + 15с таймаут на фронте
- Инкрементальный рендер маркеров (кэш по id)

## UI
- Тёмная тема (#0d0d0d), Segoe UI / system-ui
- Inline CSS в index.html (единый `<style>` блок)
- Эмодзи маркеры на Leaflet карте

## Admin
- ADMIN_TG_ID: 560013667
- Джойстик перемещения (3 скорости), только для админа
- Панель: выдача ресурсов, бан/разбан, генерация рынков, maintenance mode, webhook setup

## TODO
- [ ] Кланы
