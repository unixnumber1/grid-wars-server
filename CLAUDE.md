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

## Следующие фичи (в порядке приоритета)
- [ ] Таблица лидеров
- [ ] Кланы
- [ ] Монетизация (Telegram Stars)
