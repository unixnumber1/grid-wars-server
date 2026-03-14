# GRID WARS

Telegram Mini App — геолокационная стратегия в реальном мире.

## Стек
- **Frontend**: `/public/index.html` (единый файл HTML+CSS+JS), Leaflet.js, Socket.io client
- **Backend (primary)**: Vercel Functions (`/api/*`) — REST API, тот же домен что фронт
- **Backend (VPS)**: Express + Socket.io на VPS (`overthrow.ru:8443`) — только Socket.io push
- **Proxy**: `/api/proxy.js` — опциональный проксирующий fallback на VPS
- **БД**: Supabase (service-role key, RLS off)
- **Хостинг frontend + API**: Vercel (Hobby)
- **Хостинг Socket.io**: VPS overthrow.ru (93.123.30.179), PM2, Nginx, SSL на порту 8443
- **Telegram**: Bot API + WebApp SDK
- **URL frontend**: https://grid-wars-two.vercel.app
- **URL backend**: https://overthrow.ru:8443
- **Репо backend**: https://github.com/unixnumber1/grid-wars-server.git

## Env
```
SUPABASE_URL=
SUPABASE_KEY=
BOT_TOKEN=
```

## Файлы
```
/api
  /proxy.js                — REST proxy to VPS (mixed content bypass, HTTPS→HTTP)
  /player/init.js          — init/set-username/location/pvp-initiate/pvp-flee
  /map/index.js            — GET map data / POST tick (unified polling 5s)
  /buildings/headquarters.js
  /buildings/mine.js
  /buildings/attack.js     — attack/finish/extinguish/sell
  /buildings/upgrade.js
  (collect merged into /buildings/mine.js action:collect)
  /items/index.js          — equip/unequip/sell/open-box/craft/daily-diamonds/daily-check/stars-invoice/webhook
  /market/index.js         — listings/buy/list-item/cancel/attack-courier/pickup-drop/move-couriers
  /bots.js                 — spawn/move/attack/repel/lure
  /vases.js                — spawn/break/cron
  /clan.js                 — build-hq/create/list/join/leave/donate/upgrade/set-role/kick/transfer/info
  /admin/maintenance.js    — reward/ban/unban/generate-markets/maintenance-start/end/fix-hq/setup-webhook
/lib
  supabase.js  grid.js  haversine.js  income.js  formulas.js  items.js  bots.js  vases.js  xp.js  clans.js
/public
  index.html
vercel.json  CLAUDE.md
```

## БД (Supabase)

| Таблица | Ключевые колонки |
|---------|-----------------|
| `players` | telegram_id, game_username, avatar, coins(BIGINT), diamonds, level, xp, hp, max_hp, attack, bonus_attack, bonus_crit, bonus_hp, equipped_sword, equipped_shield, shield_until, is_banned, daily_diamonds_claimed_at, clan_id, clan_role, clan_left_at |
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
| `clans` | name, symbol, color, description, min_level, level(1-10), treasury(BIGINT), leader_id |
| `clan_members` | clan_id, player_id, role(leader/officer/member), joined_at, left_at |
| `clan_headquarters` | player_id, clan_id, lat, lng, cell_id |

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

### Кланы
- Штаб клана (clan_headquarters): 10М монет, на карте маркер 🏰
- Создание клана: бесплатно, нужен штаб клана
- 10 уровней клана: бусты дохода (5-30%), защиты (10-75%), радиус (75-300м)
- Апгрейд за алмазы из казны клана
- Буст дохода: x2.0-x6.5 на 24ч из казны (500-5000💎), boostCost/boostMul в CLAN_LEVELS
- DB колонки: boost_started_at, boost_expires_at, boost_multiplier на таблице clans
- Роли: leader, officer, member; лидер может менять роли, кикать, распустить клан
- Автопередача лидерства при 7 днях неактивности лидера
- Шахты в зоне штаба клана получают income_bonus, defense_bonus и boost_multiplier
- Редактирование клана: лидер может менять цвет/описание/мин.уровень бесплатно, название/символ за 100💎 каждое
- POST /api/clan action:(build-hq/create/join/leave/donate/upgrade/boost/set-role/kick/transfer/sell-hq/disband/edit)
- GET /api/clan?view=list — список кланов; GET /api/clan?view=info&clan_id=... — инфо
- UI: fullscreen экран с вкладками (Штаб/Участники/Кланы), попап на карте минимальный

### Unified Tick
- POST /api/map action:tick каждые 5с — заменяет 7+ polling-запросов
- Возвращает: player, buildings, bots, vases, couriers, drops, markets, online_players, notifications, clan_hqs
- Периодическая чистка БД каждые 60 тиков (~5мин)

## Оптимизации
- Optimistic locking на coins/diamonds/vases
- Rate limiting: 30 req/min на attack/buy/list-item/lure/repel
- .limit() на все unbounded запросы
- AbortController + 15с таймаут на фронте
- Инкрементальный рендер маркеров (кэш по id)
- Плавная анимация маркеров между тиками (easeInOut интерполяция):
  - Боты: клиентская экстраполяция по direction+speed + drift correction к серверу за 4.5с
  - Курьеры: клиентская интерполяция к target через requestAnimationFrame
  - Игрок: smooth GPS-переход за 1с, круги (200м/500м) анимируются синхронно с маркером
  - Другие игроки: анимация позиции за 4.5с
- GPS: порог 5м — GPS-джиттер < 5м игнорируется для предотвращения дёрганья
- Coin action cooldown: 8с после любого действия с монетами tick не перезаписывает баланс
- Пассивный доход: локальный счётчик монет каждую секунду (без записи в БД)
- Условное логирование на VPS: `lib/log.js` — только при `NODE_ENV=development`
- Автодеплой VPS: webhook.js (pm2, GitHub push → git pull + restart)

## UI
- Тёмная тема (#0d0d0d), Segoe UI / system-ui
- Inline CSS в index.html (единый `<style>` блок)
- Эмодзи маркеры на Leaflet карте
- PvP: fullscreen battle animation с HP барами и floating damage
- Mine attack: projectile animation + countdown overlay
- Shop: daily diamonds countdown + Stars purchase via Telegram.WebApp.openInvoice
- Mass sell: multi-select mode в инвентаре

## Admin
- ADMIN_TG_ID: 560013667
- Джойстик перемещения (3 скорости), только для админа
- Панель: выдача ресурсов, бан/разбан, генерация рынков, maintenance mode, webhook setup

## TODO
- [x] Кланы
- [x] Аудит и оптимизация (анимации, пассивный доход, логирование, автодеплой)
