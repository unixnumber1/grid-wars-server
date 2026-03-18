# GRID WARS

Telegram Mini App — геолокационная стратегия в реальном мире.

## Стек
- **Frontend**: `/public/index.html` (единый файл HTML+CSS+JS), Leaflet.js, Socket.io client
- **Backend**: Express + Socket.io + API routes на VPS (`overthrow.ru:8443`)
- **БД**: Supabase (RLS off)
- **Хостинг**: VPS overthrow.ru (138.124.87.99), PM2, Nginx, SSL на порту 8443
- **Telegram**: Bot API + WebApp SDK
- **URL**: https://overthrow.ru:8443
- **Репо**: https://github.com/unixnumber1/grid-wars-server.git (единый)
- **Деплой**: `git push server master:main` → front-watcher подхватывает за 30с
- **Автодеплой**: scripts/front-watcher.js — git pull единого репо каждые 30с

## Env
```
SUPABASE_URL=
SUPABASE_KEY=
BOT_TOKEN=
PORT=3000
GH_TOKEN=
```

## Файлы
```
server.js                    — Express + Socket.io + game loops
ecosystem.config.cjs         — PM2 конфиг (grid-wars + front-watcher)
package.json                 — зависимости
CLAUDE.md
/routes
  player.js                  — init/set-username/location/pvp-initiate/pvp-attack/pvp-flee
  map.js                     — GET map data / POST tick (unified polling 5s)
  buildings.js               — HQ place/upgrade/sell, mine build/upgrade/hit/extinguish/sell
  items.js                   — equip/unequip/sell/open-box/craft/upgrade-item/daily-diamonds
  market.js                  — listings/buy/list-item/cancel/attack-courier/pickup-drop
  bots.js                    — attack
  vases.js                   — spawn/break/cron
  clan.js                    — build-hq/create/join/leave/donate/upgrade/boost/set-role/kick/transfer/edit
  admin.js                   — reward/ban/unban/generate-markets/maintenance-start/end/fix-hq
  monuments.js               — start-raid/attack-shield/attack-monument/attack-defender/open-loot-box
  collectors.js              — build/upgrade/deliver/sell/hit
  ore.js                     — capture/hit/switch-currency
  cores.js                   — install/uninstall/upgrade/inventory
  economy.js                 — collect
  shop.js                    — star payments
/lib
  supabase.js  gameState.js  persist.js  formulas.js  grid.js  haversine.js
  items.js  bots.js  vases.js  xp.js  clans.js  markets.js  monuments.js
  collectors.js  oreNodes.js  cores.js  log.js
/socket
  gameLoop.js                — 5с тик: боты, курьеры, cleanup, монументы
  events.js                  — socket event handlers
/public
  index.html                 — единый фронтенд
/scripts
  test-smoke.js              — smoke test (36 тестов)
  front-watcher.js           — автодеплой: git pull → копия фронта → pm2 restart
  deploy.sh                  — деплой на VPS (устарел, использовать git push)
  startup.sh                 — первый запуск после миграции
  setup-new-server.sh        — полная установка нового VPS
```

## БД (Supabase)

| Таблица | Ключевые колонки |
|---------|-----------------|
| `players` | telegram_id, game_username, avatar, coins(BIGINT), diamonds, ether(BIGINT), level, xp, hp, max_hp, attack, bonus_attack, bonus_crit, bonus_hp, equipped_sword, equipped_shield, shield_until, is_banned, daily_diamonds_claimed_at, clan_id, clan_role, clan_left_at |
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
| `monuments` | lat, lng, cell_id, level(1-10), name, hp, max_hp, shield_hp, max_shield_hp, shield_regen, phase(shield/open/defeated), raid_started_at, respawn_at |
| `monument_raid_damage` | monument_id, player_id, damage_dealt, shield_damage |
| `monument_defenders` | monument_id, emoji, hp, max_hp, attack, wave, lat, lng, alive |
| `monument_loot_boxes` | monument_id, player_id, player_name, player_avatar, box_type(trophy/gift), monument_level, gems, items(JSONB), opened, lat, lng, expires_at |
| `collectors` | owner_id, lat, lng, cell_id, level(1-10), hp, max_hp, stored_coins(BIGINT), last_collected_at |
| `cores` | id, owner_id, mine_cell_id, slot_index(0-9), core_type(income/capacity/hp/regen), level(0-100), created_at |

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

### Гоблины (lib/goblins.js)
- Единственный тип моба: 👺 Гоблин-вор
- 3 состояния: roaming (бродит) → aggro (бежит к шахте) → fleeing (убегает с добычей)
- HP: 50, атака: 15, награда: 1-3💎 + 75 XP
- Ночью (0-6 МСК) спаунятся в 1.5x больше, агрессия 70% вместо 50%
- Кража: aggro к шахте в 500м, ворует с расстояния 100м, drain_per_sec * 3 за тик
- Fleeing: убегает с добычей, при убийстве дропает 50% украденного
- Маркер: 👺 (бродит), 👺+❗ справа сверху (атакует), 👺+💰 снизу (убегает с лутом)
- Глобальный лимит: 50, зона спауна: 500м-3км от игрока
- DB колонки: state, stolen_coins, waypoint_lat/lng, last_state_change
- API: POST /api/bots action:attack (единственное действие)

### Боевая система (реал-тайм снаряды)
- **Единая механика**: нажал кнопку → POST запрос → сервер считает урон → Socket.io emit снаряда
- **КД по оружию**: sword 500ms, axe 700ms, без оружия 200ms
- **Реген HP игрока**: 10 HP/сек (calcHpRegen в formulas.js)
- **Auto-fire**: зажатие кнопки ⚔️ → автоатака по КД
- **Rate limiting**: lastAttackTime Map в памяти сервера, 1 атака за КД на игрока
- **Socket.io события**: `projectile`, `mine:hp_update`, `pvp:hit`, `pvp:kill`
- **Снаряды**: div поверх карты, latLng→px, easeIn 200-600ms, 💥 вспышка + floating damage

### Атака построек
- POST /api/buildings/attack action:hit — одиночный удар по шахте
- Статусы: normal → under_attack → burning → destroyed
- HP шахт: getMineHp(level), регенерация 25%/ч
- Burning → уничтожение через 24ч, владелец может потушить (25% HP)
- При попадании: emit `projectile` + `mine:hp_update` nearby 1км
- HP бары на маркерах шахт обновляются в реалтайме

### PvP
- POST /api/player/init action:pvp-attack — одиночный удар по игроку
- HP урон в реалтайме, щит 10мин после смерти, кулдаун 30мин между игроками
- Проигравший теряет 10% монет, победитель получает 50% от этого
- Старый 3-раундовый бой (pvp-initiate) сохранён для совместимости

### Маркет
- Торговля предметами за алмазы, 10% комиссия
- Автоспаун рынков: при входе игрока проверяется наличие рынка в 5км, если нет — спаунится
- Overpass API: 2-tier поиск — 1) ТЦ/универмаги/marketplace/retail 2) супермаркеты/коммерческие/площади/перекрёстки
- Рынки ставятся в центр гекса, замещают шахты если нужно (с уведомлением владельцу)
- lib/markets.js: ensureMarketNearPlayer(), вызывается из api/player/init.js (fire-and-forget)
- Мин 500м между рынками
- Курьеры на карте, PvP перехват курьеров
- Макс 10 листингов, цена 1-100K💎, TTL 48ч

### Кланы
- Штаб клана (clan_headquarters): 10М монет, на карте маркер 🏰
- Создание клана: бесплатно, нужен штаб клана
- 10 уровней клана: бусты дохода (5-30%), защиты (10-75%), радиус (75-300м)
- Апгрейд за алмазы из казны клана
- Буст дохода: x2.0-x6.5 на 24ч из казны (500-5000💎), boostCost/boostMul в CLAN_LEVELS, Telegram-уведомление всем участникам
- DB колонки: boost_started_at, boost_expires_at, boost_multiplier на таблице clans
- Роли: leader, officer, member; лидер может менять роли, кикать, распустить клан
- Автопередача лидерства при 7 днях неактивности лидера
- Шахты в зоне штаба клана получают income_bonus, defense_bonus и boost_multiplier
- Редактирование клана: лидер может менять цвет/описание/мин.уровень бесплатно, название/символ за 100💎 каждое
- POST /api/clan action:(build-hq/create/join/leave/donate/upgrade/boost/set-role/kick/transfer/sell-hq/disband/edit)
- GET /api/clan?view=list — список кланов; GET /api/clan?view=info&clan_id=... — инфо
- UI: fullscreen экран с вкладками (Штаб/Участники/Кланы), попап на карте минимальный

### Монументы (рейд-боссы)
- Спавн: Overpass API (historic, tourism, amenity, library, theatre, townhall), только городская инфраструктура, 3 на кластер HQ
- Монументы ставятся в центр гекса, замещают шахты (с уведомлением владельцу)
- 10 уровней (взвешенно: lv1-3=50%, lv4-7=35%, lv8-10=15%): HP 30K-20M, щит 5K-2.5M
- Фазы: shield → open (щит пробит, появляются защитники) → defeated (7 дней респавн)
- Если open-фаза длится >4ч без слома — монумент полностью регенерируется и покрывается щитом
- Щит регенерирует: shield_regen * 5HP каждые 5 сек
- Защитники (monument_defenders): волны по порогам HP (каждые 10%), НЕ по таймеру
- Защитники двигаются: преследуют ближайшего игрока, атакуют с 50м; без игроков — бродят в 200м от монумента
- Урон по монументу: только если нет живых защитников
- Уведомления (wave_spawn, shield_broken, vulnerable, defeated) — только участникам рейда (не всем)
- Авто-join: любая атака (щит/монумент/защитник) добавляет игрока в рейд
- Лут: пропорционально урону, trophy (топ-1) / gift (остальные), гемы + предметы
- Лут-боксы на карте 24ч, только владелец может открыть, без подписей на маркере
- Визуал: полупрозрачный голубой купол (shield), прогресс-бар только при повреждении (60% ширины)
- Еженедельный ресет: воскресенье 00:00 МСК
- POST /api/monuments action:(start-raid/attack-shield/attack-monument/attack-defender/open-loot-box)
- GET /api/monuments?monument_id=...&telegram_id=... — данные монумента
- Socket: monument:shield_broken, monument:wave_spawn, monument:vulnerable, monument:defeated, monument:loot_dropped, monument:knocked_out, monument:shield_restored, monument:shield_update, monument:hp_update, monument:defender_killed
- Game loop: server.js startMonumentLoop() — 5с тик для щита/регена, движения защитников, атак

### Автосборщики (collectors)
- Постройка: 75💎, ставится в центр гекса рядом с кластером своих шахт
- Автосбор каждый час (server.js setInterval 1ч): собирает монеты со всех шахт владельца в радиусе 200м
- Вместимость: суммарный_доход_шахт × capacity_hours[level] (6ч-48ч по уровням)
- 10 уровней: HP 3K-90K, апгрейд за монеты (500K-3.28B)
- Доставка: курьер от сборщика к игроку, 10% комиссия, монеты начисляются при доставке
- PvP: атака чужого сборщика (500м), при уничтожении атакующий получает ВСЕ накопленные монеты
- Продажа: 37💎 + все накопленные монеты
- Маркер: ⚙️ с полоской заполненности, зелёный glow (свой) / красный (чужой), мигает "ПОЛНЫЙ" при >90%
- PIN fix: пин на штаб работает только если штаб стоит 24+ часов (headquarters.created_at)
- POST /api/collectors action:(build/upgrade/deliver/sell/hit)
- Socket: collector:hp_update, collector:destroyed

### Unified Tick
- POST /api/map action:tick каждые 5с — заменяет 7+ polling-запросов
- Возвращает: player, buildings, bots, vases, couriers, drops, markets, online_players, notifications, clan_hqs, monuments, monument_defenders, loot_boxes
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
- Автодеплой VPS: front-watcher.js (git fetch+reset каждые 30с, pm2 restart при изменении бэкенда)

## Спавн и размещение объектов
- **Монументы, рынки**: ставятся в центр H3-гекса, замещают шахты (с уведомлением владельцу)
- **Вазы**: случайные координаты (не центр гекса), НЕ замещают шахты, 300м между вазами
- **Рудники**: случайные координаты, НЕ замещают шахты, 200м между рудниками
- **Вазы авто-спавн**: внутренний таймер в server.js, полночь МСК ежедневно (setInterval 30мин + проверка mskHour===0)
- **Боты**: `loadFromDB` загружает только живых (`expires_at > now`)

## Z-Index слои (Leaflet zIndexOffset)
- **10000** — Игрок
- **5000** — Другие игроки
- **4000** — Боты, курьеры, защитники монументов
- **3000** — Монументы, рынки
- **2000** — Рудники, вазы
- **1000** — Шахты, штабы, клан-штабы, посылки, награды

## UI
- Тёмная тема (#0d0d0d), Segoe UI / system-ui
- Inline CSS в index.html (единый `<style>` блок)
- Эмодзи маркеры на Leaflet карте
- **Попапы**: card-based дизайн, фон #1a1a2e, карточки статов #252538, кнопки border-radius 12px
  - `openPopup(title, subtitle, stats, actions)` → рендерит в `popup-card` innerHTML
  - Кнопки: зелёный (primary), синий (yellow/upgrade), красный (danger), серый (disabled)
  - Все тексты на русском, ✕ закрытие в хедере
  - Кастомные попапы (штаб, сборщик) пишут напрямую в `popup-card`
- **Навигация**:
  - Верхний блок (левый угол, 2 строки): 💰 монеты · ⚡ доход/ч | 💎 алмазы
  - Правая вертикальная панель: 📍/🏰 PIN-переключатель (реальная позиция ↔ штаб), 🛒 магазин, 🎪 рынок, 🏆 лидерборд, ⚙️ настройки
  - Нижняя панель: аватар (тап = центрировать камеру) + ник/уровень/XP бар + кнопка Собрать
  - PIN-кнопка: toggle 📍↔🏰, POST /api/player/init action:location, золотая подсветка в активном режиме, GPS watchPosition блокируется при pinMode=true
- Level-up: компактный тост слева под валютами, ⭐ УРОВЕНЬ X + XP, золотые частицы, слайд-анимация
- Статы игрока фиксированы: attack=10, max_hp=100 (не зависят от уровня), крит только от экипированного меча
- PvP: fullscreen battle animation с HP барами и floating damage
- Mine attack: projectile animation + countdown overlay
- Shop: 3 вкладки (Боксы/Stars/Бонус), 6 паков алмазов (100-15000💎), шансы боксов inline
- Маркет: единый стиль хедера, карточки 16px с зелёной кнопкой Купить, FAB sticky
- Mass sell: multi-select mode в инвентаре
- Клан: экран редактирования с карточками-секциями, кнопка ✏️ в хедере
- Настройки: fullscreen экран с вкладками (Профиль/Карта/Админ)
  - Профиль: аватар 60px + смена ника, card-секции
  - Карта: 5 стилей (standard/light/total_black/neon/blood), canvas-превью, localStorage
  - Админ: только для ADMIN_TG_ID, кнопки с цветовой кодировкой

## Admin
- ADMIN_TG_ID: 560013667
- Джойстик перемещения (3 скорости), только для админа
- Панель: выдача ресурсов, бан/разбан, генерация рынков, maintenance mode, webhook setup

## Архитектурные правила

### In-Memory Game State (lib/gameState.js)
- **ВСЕ чтения** игрового состояния — только из `gameState` (не из Supabase)
- `supabase.from(...).select()` **запрещён** в тике и polling эндпоинтах
- Новые объекты (боты, постройки, итемы) — сначала в gameState, потом `markDirty()`
- **Критичные транзакции** (деньги, PvP, крафт, покупка) — немедленная запись в Supabase + обновление gameState
- Каждый новый эндпоинт должен обновлять gameState синхронно
- `gameState.loadFromDB()` вызывается при старте сервера (server.js)
- Если `gameState.loaded === false` — fallback к прямым DB запросам

### Batch Persist (lib/persist.js)
- Каждые 30 секунд все "dirty" объекты пишутся в Supabase одним batch upsert
- `gameState.markDirty(collection, id)` — пометить объект для записи
- `persistNow(table, data)` — немедленная запись для критичных операций
- Bot/courier movement — только в памяти, persist через batch

### Серверные процессы
- `socket/gameLoop.js` — основной игровой цикл (5с): движение ботов/курьеров, cleanup
- `routes/map.js` handleTick — HTTP тик: чтение snapshot из gameState, 0 DB запросов
- Движение ботов и курьеров — ТОЛЬКО в gameLoop (не дублировать в handleTick)

### Боевые события (реал-тайм)
- Снаряды, урон, HP обновления идут через Socket.io emit, НЕ через тик
- `lastAttackTime` Map в server.js — rate limiting атак per player (КД оружия)
- HP игроков хранится в gameState.players[id].hp, обновляется при каждом попадании
- Новые боевые эндпоинты (pvp-attack, mine hit) должны: читать из gameState → emit через io → markDirty
- `emitToNearbyPlayers(lat, lng, radius, event, data)` — broadcast Socket.io в радиусе
- Критичные данные (смерть, монеты, pvp_log) — немедленная запись в Supabase

## Тестирование

### Smoke test
- `node scripts/test-smoke.js` — запускать после каждого патча
- Если есть FAIL — починить прежде чем деплоить
- 36 тестов: gameState, API, формулы, DB, Socket.io
- `/api/health` — localhost-only эндпоинт для проверки gameState

### Правила разработки
- Не изменять файлы не связанные с текущей задачей
- При добавлении новой механики создавать новые файлы, минимально трогая существующие
- Перед крупной задачей: `git commit -m "backup: before [фича]"`
- Всегда включать `upgrade_level` при SELECT/UPDATE items (баг с обнулением)
- Items upsert safety: persist.js проставляет `upgrade_level=0` если null

## Безопасность

### Nginx (DDoS защита)
- `limit_req_zone` API: 30r/m + burst=20, WS: 5r/s + burst=10
- `limit_conn` 20 одновременных соединений с одного IP
- `client_max_body_size 1m`, таймауты 10/30с
- `server_tokens off`, X-Frame-Options DENY, X-Content-Type-Options nosniff
- **Fail2ban**: nginx-limit-req (10 нарушений → бан 1ч IP), sshd (5 попыток → бан 24ч)

### Express middleware
- **lib/security.js** — `validateRequest` (валидация telegram_id, координат, числовых полей, XSS-очистка строк), `checkBan` (проверка бана на всех /api/ запросах)
- **lib/rateLimit.js** — rate limiting по telegram_id (не по IP): default 60/мин, attack 80/мин, tick 15/мин, build 20/мин, collect 30/мин, market 30/мин, location 120/мин
- `express.json({ limit: '100kb' })` — ограничение размера запроса

### GPS антиспуф (lib/antispoof.js)
- `validatePosition(telegramId, lat, lng, isPinMode)` — проверка физической скорости
- MAX_SPEED_KMH = 120 — максимальная физически возможная скорость
- Пин режим: максимальный прыжок 20км
- Спуфер получает ответ `ok:true` чтобы не знал что детектируется
- Автобан после 5 подтверждённых нарушений (30 дней)
- Telegram-уведомление админу с кнопками подтвердить/разбанить
- История позиций: последние 10 точек в памяти per player

### Таблица spoof_log
- player_id, violation_type, speed_kmh, distance_km, from/to координаты, created_at

### Система ядер (lib/cores.js)
- 4 типа: ✴️ доход, ✳️ вместимость, ❤️ HP, ♻️ реген
- 10 слотов на шахту (общие для всех типов)
- Дроп: с монументов lv0, шанс 2-40% зависит от уровня монумента
- Прокачка: за 🌀 Эфир
- Эфир: с рудников (выбор при захвате вместо осколков)
- Множитель: lv0=x1.5, lv10=x21.2, lv50=x62.1, lv100=x100
- Складываются АДДИТИВНО: 10 ядер lv100 = x1000
- POST /api/cores action:(install/uninstall/upgrade/inventory)
- DB: таблица cores (id, owner_id, mine_cell_id, slot_index, core_type, level)
- gameState.cores Map, getCoresForMine(cell_id), getPlayerCores(playerId)

### Буст от количества шахт
- +0.1% к доходу ВСЕХ шахт за каждую шахту
- 1000 шахт = x2 к доходу
- Считается в map.js handleTick через getMineCountBoost(count)

### H3 Resolution
- Текущий: 10 (изменён с 11)
- Диаметр гекса: ~65м
- В круге 200м: ~6-8 шахт

### Новая формула дохода
- getMineIncome(level) = 50 * level^2 / 3600 (возвращает coins/sec)
- lv1: 50/ч, lv100: 500K/ч, lv200: 2M/ч
- getMineCapacity использует tiered hours (6ч до lv50, до 480ч на lv200+)

### Валюты рудников
- ore_nodes.currency: 'shards' (по умолчанию) или 'ether'
- Выбор при захвате, можно менять через action:switch-currency
- POST /api/ore action:switch-currency

## TODO
- [x] Монументы (рейд-боссы)
- [x] Автосборщики
- [x] Кланы
- [x] Аудит и оптимизация (анимации, пассивный доход, логирование, автодеплой)
- [x] In-Memory Game State (gameState + persist)
- [x] Защита от DDoS, взлома и GPS спуфинга
- [x] Система ядер + экономический ребаланс

## Деплой — ЕДИНСТВЕННЫЙ ПРАВИЛЬНЫЙ МАРШРУТ

### Источник правды
- **Единый файл**: `/var/www/grid-wars-server/public/index.html`
- **Симлинк**: `/var/www/html/index.html` → `/var/www/grid-wars-server/public/index.html`
- **Единый репо**: `https://github.com/unixnumber1/grid-wars-server.git` (и фронт, и бэкенд)

### Маршрут деплоя
1. Редактировать файлы локально (Cursor)
2. `git add . && git commit -m "описание"`
3. `git push server master:main`
4. `front-watcher` автоматически подтягивает через 30 сек (`git fetch + reset --hard origin/main`)
5. Если изменился бэкенд (server.js / routes/ / lib/ / socket/) — автоматически `pm2 restart grid-wars`
6. Фронт копируется в `/var/www/html/index.html` (симлинк)

### Git remotes (локальная машина)
- `server` → `https://github.com/unixnumber1/grid-wars-server.git` (основной, и фронт и бэкенд)
- `front` → `https://github.com/unixnumber1/grid-wars-front.git` (deprecated, не использовать)

### НИКОГДА
- Не копировать index.html через SCP/PSCP — front-watcher затрёт через 30 сек
- Не редактировать файлы на VPS напрямую — `git reset --hard` их затрёт
- Не использовать `pm2 restart all` — ломает front-watcher (использовать `pm2 restart grid-wars`)
- Не держать несколько версий index.html на сервере
- Не пушить в `grid-wars-front` (удалён с VPS)

### Проверка после деплоя
```bash
grep -c 'collector\|monument' /var/www/grid-wars-server/public/index.html  # > 0
ls -la /var/www/html/index.html  # должен быть симлинк
pm2 logs front-watcher --lines 5 --nostream
```
