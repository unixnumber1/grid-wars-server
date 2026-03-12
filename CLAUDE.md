# GRID WARS — Project Context

## Что это
Telegram Mini App — геолокационная стратегия в реальном мире.
Игроки физически перемещаются, захватывают территории, строят шахты.

## Стек
- Frontend: `/public/index.html` (единый файл, Leaflet.js, эмодзи-визуал)
- Backend: Vercel Functions (`/api/*`)
- БД: Supabase
- Хостинг: Vercel
- Telegram: Bot API + WebApp

## Механика
**Штаб 🏛️** — один на игрока, хранит монеты (лимит 10000), нельзя захватить
**Шахта ⛏️** — строится в радиусе 500м, генерирует монеты пассивно, 10 уровней, можно захватить подойдя на 50м

### Уровни шахты
| Уровень | Монет/сек | Стоимость |
|---------|-----------|-----------|
| 1 | 1 | бесплатно |
| 2 | 2 | 50 |
| 3 | 4 | 150 |
| 4 | 7 | 300 |
| 5 | 11 | 500 |
| 6 | 16 | 800 |
| 7 | 22 | 1200 |
| 8 | 29 | 1800 |
| 9 | 37 | 2500 |
| 10 | 46 | 3500 |

### Расчёт монет
Пассивный, считается в момент сбора:
`coins = rate_per_sec * (now - last_collected) в секундах`

### Захват
- Дистанция < 50м → мгновенный захват
- Накопленные монеты сгорают
- Бывший владелец получает уведомление в Telegram

## Структура БД (Supabase)
- `players` — telegram_id, username
- `headquarters` — player_id, lat, lng, cell_id, coins
- `mines` — owner_id, original_builder_id, lat, lng, cell_id, level, last_collected

## Структура файлов
```
/api
  /player/init.js
  /map/index.js
  /buildings/headquarters.js
  /buildings/mine.js
  /buildings/capture.js
  /buildings/upgrade.js
  /economy/collect.js
  /shop/open-box.js
  /admin/maintenance.js
  /admin/fix-hq.js
/lib
  supabase.js
  grid.js
  haversine.js
  income.js
/public
  index.html
vercel.json
CLAUDE.md
```

## Переменные окружения
```
SUPABASE_URL=
SUPABASE_KEY=
BOT_TOKEN=
```

## Экономика v4 (актуальная)

### Шахты — 250 уровней
- Стартовый уровень: **0** (неактивен, доход = 0)
- Активация (0→1): **100 монет**
- Стоимость апгрейда FROM уровня L: `getMineUpgradeCost(L)`:
  - L≤50: `100 * 1.21^(L-1)`, L≤100: `e1 * 5 * 1.15^(L-51)`, L≤150: `e2 * 8 * 1.13^(L-101)`
  - L≤200: `e3 * 12 * 1.12^(L-151)`, L>200: `e4 * 20 * 1.11^(L-201)`
  - Milestone x4 каждые 10 уровней, кап 9Q
- Доход: `getMineIncome(L)` = `getMineUpgradeCost(L) / getPayback(L)` монет/сек
  - Payback (сек): L≤50: 3600→21600, L≤100: 21600→259200, L≤150: 259200→1.2M, L≤200: 1.2M→5.2M, L>200: 5.2M→31.5M
- Ёмкость: `getMineCapacity(L)` = income * days * 86400 (L≤100: 6д, L≤150: 5д, L≤200: 4д, L>200: 3д)
- Все формулы в `/lib/formulas.js`

### Внешний вид построек (getMineAppearance)
| Уровни  | Emoji | Название             |
|---------|-------|----------------------|
| 0-9     | 🪨   | Каменный алтарь      |
| 10-19   | 🔮   | Магический колодец   |
| 20-29   | 🌿   | Друидическая роща    |
| 30-39   | 🔥   | Огненный маяк        |
| 40-49   | ⚗️   | Алхимическая башня   |
| 50-59   | 🌀   | Портал разлома       |
| 60-69   | 🏯   | Тёмная цитадель      |
| 70-79   | 💎   | Кристальный шпиль    |
| 80-89   | 🌙   | Лунный обелиск       |
| 90-99   | ⭐   | Звёздный Nexus       |
| 100-109 | 🌌   | Астральный разлом    |
| 110-119 | 👁️   | Глаз Вечности        |
| 120-129 | 🐉   | Драконье гнездо      |
| 130-139 | ☄️   | Метеоритный кратер   |
| 140-149 | 🌋   | Вулканический трон   |
| 150     | 👑   | Трон Богов           |

### Штаб — 10 уровней
- Апгрейд: `POST /api/buildings/headquarters` с `action: 'upgrade'`
- Поле `level` (integer, default 1) в таблице `headquarters`
- maxMineLevel и maxMines лимиты **удалены** — шахт можно строить неограниченно

### Аватарки
- 46 эмодзи на выбор, хранятся в `players.avatar`
- Смена: `POST /api/player/avatar`
- Визуал на карте: эмодзи аватарки вместо синей точки

## Стартовый бонус новым игрокам
При постройке первого штаба (`starting_bonus_claimed = false`):
- **100 000 монет** + **100 алмазов**
- Логика в `api/buildings/headquarters.js` (поле `starting_bonus_claimed` в `players`)

## Две зоны взаимодействия (SMALL_RADIUS / LARGE_RADIUS)

Радиус **не зависит** от уровня игрока. Константы в `lib/formulas.js`.

| Зона | Радиус | Цвет на карте | Действия |
|------|--------|---------------|----------|
| Малый круг (build) | 200м | 🔵 синий пунктир, 5% заливка | строить/улучшать шахты, собирать монеты |
| Большой круг (combat) | 500м | 🔴 красный пунктир, без заливки | атаковать ботов |

### Бэкенд
- `mine.js` — H3 getCellsInRange проверка (player_lat/player_lng обязательны)
- `upgrade.js` — haversine проверка ≤ 200м (lat/lng обязательны, без fallback)
- `collect.js` — H3 getCellsInRange фильтр (lat/lng обязательны, без fallback)
- `bots.js` (attack/repel/lure) — проверка дистанции ≤ 500м (LARGE_RADIUS, haversine)
- `vases.js` (break) — проверка дистанции ≤ 200м (SMALL_RADIUS, haversine)

### Фронтенд
- `playerZoneCircle` — L.circle 200м, `rgba(100,200,255,0.6)`, dashArray
- `playerCombatCircle` — L.circle 500м, `rgba(255,80,80,0.4)`, dashArray
- Оба обновляются в `_applyPlayerPosition()` при движении игрока
- Попап шахты: показывает дистанцию (зелёный ≤200м / красный >200м)
- Кнопки "Улучшить", "Bulk", "Продать" — disabled если вне зоны 200м
- GPS guard: doUpgrade, doCollect, doBuildMine — все требуют GPS

## Текущий статус
- ✅ Базовый геймплей работает
- ✅ Штаб и шахты строятся
- ✅ Сбор монет работает
- ✅ Задеплоено на Vercel
- ✅ Экономика v2: 100 уровней шахт, 10 уровней штаба
- ✅ Аватарки игроков (46 вариантов)
- ✅ Скины домиков по уровням
- ✅ Меню настроек (drawer)
- ✅ Монеты хранятся в players.coins (BIGINT, не в headquarters.coins)
- ✅ Механика захвата шахт удалена
- ✅ Лимит количества шахт по уровню штаба удалён
- ✅ Маркер персонажа: 44px эмодзи, pointer-events:none (клики сквозь), drop-shadow, zIndex 500
- ✅ z-index слои: шахты 450, штаб 480, свой игрок 500, чужие игроки 600 (кликабельны), боты 1500
- ✅ Две зоны: build 200м (синий) + combat 500м (красный)
- ✅ formatNumber() — единое форматирование чисел (К, М, В, Т) для монет, дохода, XP
- ✅ Монеты хранятся как целые числа (BIGINT), без COIN_SCALE деления
- ✅ Магазин с боксами (редкий 💎5, эпический 💎30)
- ✅ HUD: островок баланса (💰⚡💎 + кнопки 🛒/🔜), островок кнопок (📍🏆⚙️)
- ✅ Админ-панель: выдача ресурсов, бан/разбан игроков
- ✅ Система банов: экран бана, авто-разбан по истечении срока
- ✅ Штаб — необязательная постройка (нет принудительного экрана при входе)
- ✅ Продажа штаба работает даже при дублях (удаляет все HQ игрока)
- ✅ Админ: кнопка "Почистить дубли штабов" (`/api/admin/fix-hq`)

## Магазин (Shop)

### Эндпоинт: `POST /api/shop/open-box`
- Принимает: `{ telegram_id, box_type }` где box_type: `'rare'` | `'epic'`
- Стоимость: rare = 5💎, epic = 30💎
- Шансы редкого бокса: common 40%, uncommon 35%, rare 20%, epic 4%, mythic 1%
- Шансы эпического бокса: uncommon 35%, rare 35%, epic 20%, mythic 10%
- Legendary НЕ выпадает из боксов
- Тип предмета: 50/50 sword/shield
- Возвращает: `{ success, item, diamondsLeft }`

### Фронтенд
- Кнопка 🛒 в островке баланса (левый верхний угол, `#btn-shop-hud`)
- Fullscreen модалка `#shop-modal` с хедером (баланс монет/алмазов)
- Два бокса: 📦 Редкий (зелёное свечение) и 🎁 Эпический (розовое свечение)
- Кнопка "Инфо" показывает шансы в popup
- Анимация открытия: бокс → тряска → вспышка цвета редкости → показ предмета
- Кнопка "Открыть" неактивна если алмазов не хватает

### Цвета редкости (RARITY_COLORS)
| Редкость   | Цвет    | Hex / CSS                                              |
|-----------|---------|-------------------------------------------------------|
| common    | серый   | `#888888`                                              |
| uncommon  | синий   | `#2979ff`                                              |
| rare      | зелёный | `#00c853`                                              |
| epic      | кислотно-розовый | `#ff00aa`                                     |
| mythic    | бордовый | `#8b0000`                                             |
| legendary | золотой | `linear-gradient(90deg, #FFD700, #FF8C00, #FFD700)`    |

- RARITY_ORDER: legendary(0) → mythic(1) → epic(2) → rare(3) → uncommon(4) → common(5)
- Инвентарь отсортирован по RARITY_ORDER (сначала легендарные)
- Legendary: анимированный градиентный текст (legendaryShimmer) + анимированная рамка (legendaryBorder)
- Константы дублируются: `lib/items.js` (бэкенд) + `RARITY_COLORS_CLIENT` в `index.html` (фронтенд)

## SQL для новых полей
```sql
ALTER TABLE players      ADD COLUMN IF NOT EXISTS avatar text DEFAULT '🐺';
ALTER TABLE headquarters ADD COLUMN IF NOT EXISTS level  integer DEFAULT 1;
ALTER TABLE players      ADD COLUMN IF NOT EXISTS coins  BIGINT NOT NULL DEFAULT 0;
```

## H3 Hex Grid (актуально)

- h3-js добавлен в зависимости
- Разрешение: 11 (hex ~50m diameter)
- Радиус взаимодействия: gridDisk(12) ≈ 500m
- cell_id теперь H3 cell ID (строка вида '8b2830828052dff')
- getCellsInRange() используется во всех endpoint'ах вместо haversine
- Фронтенд: H3 CDN, hexLayer (L.layerGroup), playerZoneCircle (L.circle)
- Гексы рисуются только при zoom ≥ 14
- Клик на гекс → handleHexClick(cellId)
- /api/admin/reset.js — временный endpoint для очистки БД (удалить после использования)

## SQL миграция
```sql
DELETE FROM mines;
DELETE FROM headquarters;
```

## Система уровней игрока

### Таблица players
```sql
ALTER TABLE players ADD COLUMN IF NOT EXISTS level integer DEFAULT 1;
ALTER TABLE players ADD COLUMN IF NOT EXISTS xp    integer DEFAULT 0;
```

### Формулы (lib/formulas.js)
- `xpForLevel(level)` = `floor(100 * level^1.9)` — XP для перехода с level на level+1
- `calculateLevel(totalXp)` — вычисляет текущий уровень по суммарному XP
- `SMALL_RADIUS` = 200м (build zone), `LARGE_RADIUS` = 500м (combat zone)

### XP rewards (lib/xp.js → XP_REWARDS)
| Действие | XP |
|---|---|
| BUILD_MINE | 10 |
| BUILD_HQ | 50 |
| COLLECT_COINS | 0.1% от собранных монет (min 1) |
| UPGRADE_MINE(newLevel) | 5 * newLevel |
| UPGRADE_HQ | 200 |
| BREAK_VASE | 50 |

### Радиус взаимодействия (фиксированный)
- SMALL_RADIUS=200м: mine.js, upgrade.js, collect.js
- LARGE_RADIUS=500м: bots.js (attack/repel/lure)
- Вазы: break ≤ 200м (SMALL_RADIUS)
- grid.js: `radiusToDiskK(meters)` конвертирует метры в H3 disk-K

## Система ботов (актуально)

### Концепция зон спауна
- Каждый онлайн-игрок имеет зону 2км, в которой всегда 10 ботов
- Бот спаунится в кольце 500м–2000м от игрока
- Боты глобальные — видны всем, кто смотрит в эту область
- expires_at = 5 мин. Фронт вызывает spawn каждые 15с → автопополнение
- Перемещение глобальное: один вызов move (каждые 3с) двигает всех ботов

### Таблица `bots`
```sql
CREATE TABLE bots (
  id uuid PK, type text, category text ('undead'|'neutral'),
  emoji text, lat float8, lng float8, cell_id text,
  direction float8,                          -- текущее направление движения (радианы)
  target_mine_id uuid→mines, spawned_for_player_id uuid→players,
  coins_drained int, reward_min int, reward_max int,
  drain_per_sec int, speed text, spawned_at timestamptz, expires_at timestamptz,
  hp int, max_hp int, attack int, size text
);
```

### Конфиг: `/lib/bots.js` (5 типов)
| Тип      | Emoji | Категория | HP   | Атака | AttackChance | Размер | markerSize |
|----------|-------|-----------|------|-------|-------------|--------|-----------|
| spirit   | 🌫️   | neutral   | 30   | 0     | 0           | S      | 32        |
| goblin   | 👺   | undead    | 50   | 8     | 0.3         | S      | 32        |
| werewolf | 🐺   | undead    | 120  | 20    | 0.5         | M      | 38        |
| demon    | 👹   | undead    | 200  | 35    | 0.6         | L      | 44        |
| dragon   | 🐲   | neutral   | 400  | 60    | 0.4         | L      | 50        |

### Конфиг: `/api/bots.js` (action-based router)
| action  | Метод | Описание |
|---------|-------|----------|
| spawn   | POST  | Поддерживает 10 ботов в зоне 2км игрока |
| move    | POST  | Direction-based движение ВСЕХ ботов, очистка expired |
| attack  | POST  | Игрок атакует бота, крит/контратака/смерть |
| repel   | POST  | Прогнать нежить |
| lure    | POST  | Приманить нейтрального |

### Движение ботов
- Скорость в метрах за тик: slow=15, medium=30, fast=55, very_fast=90
- 5% шанс небольшого поворота (±0.15 рад), иначе продолжает текущий курс
- `direction` хранится в БД (float8, радианы)
- Граница 3км от `spawn_lat/spawn_lng` — бот разворачивается к точке спауна

### Статусы злых (undead) ботов
- `roaming` → 3% per tick: выбирает случайную шахту → `attacking`
- `attacking` → идёт к шахте; при dist<0.0005° начинает drain; при `drained_amount ≥ drain_limit` → `leaving`
- `leaving` → 9% per tick (≈11 сек): возвращается в `roaming`

### drain_limit по типам
spirit:50, goblin:150, werewolf:400, demon:1000, dragon:3000, boss:10000

### Анимации атаки (frontend)
- `.bot-attacking` — пульсирующий scale 1→1.3 (0.5s) на атакующем боте
- `.mine-under-attack` — красное мигание drop-shadow (0.5s) на атакуемой шахте
- `animateDrain(mineLL, botLL)` — летящие 💰 от шахты к боту каждые 1.5с
- `showDrainText(latLng, amount)` — `-N 💸` плавает вверх над шахтой
- `drainIntervals` — map botId → intervalId для управления анимациями
- В попапе своей атакованной шахты: subtitle = "⚠️ Атакована! …", stat "Высосано: N монет"

### Отображение
- `/api/map` возвращает `bots` по bbox вместе с buildings
- `tickBotMove` (3с) также возвращает боты в viewport для плавной анимации
- `renderBots` вызывается из обоих источников без конфликтов

### Боевая механика
- `getMaxHp(level)` = 100 + (level-1)*10
- `getPlayerAttack(level)` = 10 + (level-1)*2
- `calcHpRegen`: +1 HP в секунду
- Крит: 20% шанс, x2 урон; контратака вероятностью attackChance бота
- Смерть игрока: respawn_until = now+10s, 30% HP
- XP за победу = max_hp / 5 × (undead×20, neutral×100)

### SQL миграции
```sql
ALTER TABLE players ADD COLUMN IF NOT EXISTS hp            integer;
ALTER TABLE players ADD COLUMN IF NOT EXISTS max_hp        integer;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_hp_regen TIMESTAMPTZ DEFAULT now();
ALTER TABLE players ADD COLUMN IF NOT EXISTS kills         integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS deaths        integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS respawn_until TIMESTAMPTZ;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS hp        integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS max_hp    integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS attack    integer NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS size      text    NOT NULL DEFAULT 'S';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS direction float8;
```

### Фронтенд (public/index.html)
- `BOT_CLIENT_TYPES` — зеркало lib/bots.js для markerSize/size/category
- `botIcon(bot)` — размер и свечение по size
- `showBotPopup(botId)` — HP-бары игрока и бота + кнопка атаки
- `doAttackBot(botId)` — POST attack, floating damage text, живой update HP
- `tickBotSpawn` каждые 15с, `tickBotMove` каждые 3с
- Профиль: HP-бар, attack, kills/deaths

## Система ваз 🏺

### Эндпоинт: `/api/vases` (action-based router)
| action | Метод | Описание |
|--------|-------|----------|
| spawn  | POST  | Админ: спаунит 1 вазу в 30-50м от каждого штаба |
| break  | POST  | Игрок: разбить вазу (≤200м, haversine) |
| (cron) | GET   | Vercel cron: ежедневный спаун в 00:01 МСК |

### Cron-спаун (`GET /api/vases`)
- Vercel cron: `1 21 * * *` (21:01 UTC = 00:01 МСК)
- Удаляет все expired + broken вазы одним `.or()` запросом
- Вызывает `spawnVasesForClusters()` из `lib/vases.js`
- Обновляет `last_vases_spawn` в `app_settings`
- Уведомляет онлайн-игроков через Telegram

### Спаун кластерами (`lib/vases.js`)
1. Берёт все штабы, группирует в кластеры (радиус 10км)
2. Спаунит 3-5 ваз на кластер в радиусе 500м-5км от центра
3. Минимум 500м между вазами
4. `expires_at` = +24 часа
5. `diamonds_reward` = 1-5

### Дистанция
- Разбить вазу: ≤ 200м (SMALL_RADIUS, haversine)
- Фронт: toast "⚠️ Подойди к вазе (200м)" при ошибке дистанции

## Админ-панель (расширенная)

### Эндпоинты (всё через `/api/admin/maintenance`)

#### `POST` action: `'reward'`
- `{ telegram_id, action:'reward', player_id, currency, amount }`
- currency: `'coins'` | `'diamonds'`

#### `POST` action: `'ban'`
- `{ telegram_id, action:'ban', player_id, reason, duration_days }`
- duration_days: 1 | 3 | 7 | 30 | 0 (навсегда)

#### `POST` action: `'unban'`
- `{ telegram_id, action:'unban', player_id }`

#### `GET` action: `'players-list'`
- `?action=players-list&search=ник&admin_id=xxx`
- Поиск по username (ILIKE), лимит 20, сортировка по last_seen

### Проверка бана
- В `/api/player/init.js` — после загрузки игрока
- 403 + `{ banned: true, reason, until, avatar }` если забанен
- Авто-разбан если срок истёк

### Колонки players (бан)
```sql
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_banned  BOOLEAN DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS ban_until  TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS banned_at  TIMESTAMPTZ;
```

### UI в настройках (admin-section)
- Секция "Выдать ресурсы": поиск игрока → выбор валюты → ввод суммы → выдать
- Секция "Блокировка": поиск игрока → причина + срок → забанить / разбанить

### Экран бана (фронтенд)
- Fullscreen, z-index: 99999
- Аватарка игрока в круге с красной рамкой
- Покачивающийся ⚰️ (анимация coffin 3s)
- Причина, срок, контакт для разблокировки

## Следующие фичи (в порядке приоритета)
- [ ] Таблица лидеров
- [ ] Кланы
- [ ] Монетизация (Telegram Stars)
