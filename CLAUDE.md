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

## Экономика v2 (актуальная)

### Шахты — 100 уровней
- Доход: `Math.floor(Math.pow(1.15, level - 1))` монет/сек
- Стоимость апгрейда: `Math.floor(50 * Math.pow(2.1, level - 1))`
- Все формулы в `/lib/formulas.js`

### Штаб — 10 уровней
- Определяет: макс кол-во шахт и макс уровень шахты
- Апгрейд: `POST /api/buildings/headquarters-upgrade`
- Поле `level` (integer, default 1) в таблице `headquarters`

### Аватарки
- 46 эмодзи на выбор, хранятся в `players.avatar`
- Смена: `POST /api/player/avatar`
- Визуал на карте: эмодзи аватарки вместо синей точки

### Скины шахт
- Эмодзи меняется каждые 10 уровней (🏠→🏡→…→🌇)
- Захватываемые шахты: красная обводка
- Чужие вне радиуса: opacity 0.5

## Текущий статус
- ✅ Базовый геймплей работает
- ✅ Штаб и шахты строятся
- ✅ Сбор монет работает
- ✅ Задеплоено на Vercel
- ✅ Экономика v2: 100 уровней шахт, 10 уровней штаба
- ✅ Аватарки игроков (46 вариантов)
- ✅ Скины домиков по уровням
- ✅ Меню настроек (drawer)

## SQL для новых полей
```sql
ALTER TABLE players      ADD COLUMN IF NOT EXISTS avatar text DEFAULT '🐺';
ALTER TABLE headquarters ADD COLUMN IF NOT EXISTS level  integer DEFAULT 1;
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
- `getBuildRadius(level)` — 500→550→600→700→800→1000→1500м по уровням (5/10/20/30/50/100)

### XP rewards (lib/xp.js → XP_REWARDS)
| Действие | XP |
|---|---|
| BUILD_MINE | 20 |
| BUILD_HQ | 50 |
| COLLECT_PER_50_COINS | 1 per 50 монет |
| UPGRADE_MINE(newLevel) | 10 * newLevel |
| UPGRADE_HQ | 500 |
| CAPTURE_MINE | 100 |

### Динамический радиус постройки
- mine.js использует `getBuildRadius(player.level)` вместо хардкода 500м
- grid.js: `radiusToDiskK(meters)` конвертирует метры в H3 disk-K

## Система ботов (актуально)

### Таблица `bots`
```sql
CREATE TABLE bots (
  id uuid PK, type text, category text ('undead'|'neutral'),
  emoji text, lat float8, lng float8, cell_id text,
  target_mine_id uuid→mines, spawned_for_player_id uuid→players,
  coins_drained int, reward_min int, reward_max int,
  drain_per_sec int, speed text, spawned_at timestamptz, expires_at timestamptz
);
```

### Конфиг: `/lib/bots.js` (6 типов с боевой системой)
| Тип      | Emoji | Категория | HP   | Атака | AttackChance | Размер | markerSize |
|----------|-------|-----------|------|-------|-------------|--------|-----------|
| spirit   | 🌫️   | neutral   | 30   | 0     | 0           | S      | 32        |
| goblin   | 👺   | undead    | 50   | 8     | 0.3         | S      | 32        |
| werewolf | 🐺   | undead    | 120  | 20    | 0.5         | M      | 38        |
| demon    | 👹   | undead    | 200  | 35    | 0.6         | L      | 44        |
| dragon   | 🐲   | neutral   | 400  | 60    | 0.4         | L      | 50        |
| boss     | 💀   | undead    | 1000 | 100   | 0.8         | XL     | 60        |

Боссы: 1 глобально, 5% шанс за цикл спавна + Telegram-уведомление.

### Конфиг: `/api/bots.js` (action-based router)
| action  | Метод | Описание |
|---------|-------|----------|
| spawn   | POST  | Спаун до 10 ботов, 5% шанс босса |
| nearby  | GET   | Боты в радиусе |
| move    | POST  | Хаотичное движение + дренаж через attackChance |
| attack  | POST  | Игрок атакует бота, крит/контратака/смерть |
| repel   | POST  | (legacy) прогнать нежить |
| lure    | POST  | (legacy) приманить нейтрального |

### Боевая механика
- `getMaxHp(level)` = 100 + (level-1)*10
- `getPlayerAttack(level)` = 10 + (level-1)*2
- `calcHpRegen`: +1 HP каждые 10 сек, применяется в init.js и attack handler
- Крит: 20% шанс, x2 урон; контратака вероятностью attackChance бота
- Смерть игрока: respawn с полным HP, deaths++
- XP за победу = max_hp бота / 5; монеты только для нейтральных

### SQL для боевой системы
```sql
ALTER TABLE players ADD COLUMN IF NOT EXISTS hp            integer;
ALTER TABLE players ADD COLUMN IF NOT EXISTS max_hp        integer;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_hp_regen TIMESTAMPTZ DEFAULT now();
ALTER TABLE players ADD COLUMN IF NOT EXISTS kills         integer NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS deaths        integer NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS hp     integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS max_hp integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS attack integer NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS size   text    NOT NULL DEFAULT 'S';
```

### Фронтенд (public/index.html)
- `BOT_CLIENT_TYPES` — зеркало lib/bots.js для markerSize/size/category
- `botIcon(bot)` — размер и свечение по size (S=category, M=orange, L=purple, XL=red pulse)
- CSS `.bot-boss-pulse` — pulsing animation для босса
- `showBotPopup(botId)` — HP-бары игрока и бота + кнопка атаки
- `doAttackBot(botId)` — POST attack, floating damage text, живой update HP
- `showFloatingText(text, latlng, color)` — анимированный текст на карте
- `screenShake()` — CSS animation shake (при убийстве босса)
- Профиль: HP-бар, attack, kills/deaths

## Следующие фичи (в порядке приоритета)
- [ ] Таблица лидеров
- [ ] Кланы
- [ ] Монетизация (Telegram Stars)
