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

## Экономика v3 (актуальная)

### Шахты — 150 уровней
- Стартовый уровень: **0** (неактивен, доход = 0)
- Активация (0→1): **100 монет**
- Стоимость апгрейда FROM уровня L: `getMineUpgradeCost(L)`:
  - L=0 → 100, иначе `Math.round(100 * 1.09^L)`
- Доход на уровне L: `getMineIncome(L)` = `Math.round(10 * L^1.2)` монет/сек
- Контрольные точки: Ур.10→236, Ур.50→7490, Ур.100→588k, Ур.150→46.3m
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
| Большой круг (combat) | 500м | 🔴 красный пунктир, без заливки | атаковать ботов, разбивать вазы |

### Бэкенд
- `mine.js`, `upgrade.js`, `collect.js` — проверка дистанции ≤ 200м (SMALL_RADIUS, H3 diskK)
- `bots.js` (attack/repel/lure) — проверка дистанции ≤ 500м (LARGE_RADIUS, haversine)
- `vases.js` (break) — проверка дистанции ≤ 500м

### Фронтенд
- `playerZoneCircle` — L.circle 200м, `rgba(100,200,255,0.6)`, dashArray
- `playerCombatCircle` — L.circle 500м, `rgba(255,80,80,0.4)`, dashArray
- Оба обновляются в `_applyPlayerPosition()` при движении игрока

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
- ✅ Маркер персонажа: pointer-events:none, z-index 400 (штаб 500, шахты 450)
- ✅ Две зоны: build 200м (синий) + combat 500м (красный)

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
| BUILD_MINE | 20 |
| BUILD_HQ | 50 |
| COLLECT_PER_50_COINS | 1 per 50 монет |
| UPGRADE_MINE(newLevel) | 10 * newLevel |
| UPGRADE_HQ | 500 |

### Радиус взаимодействия (фиксированный)
- SMALL_RADIUS=200м: mine.js, upgrade.js, collect.js
- LARGE_RADIUS=500м: bots.js (attack/repel/lure), vases.js (break)
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

## Следующие фичи (в порядке приоритета)
- [ ] Таблица лидеров
- [ ] Кланы
- [ ] Монетизация (Telegram Stars)
