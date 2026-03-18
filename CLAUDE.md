# GRID WARS

Telegram Mini App — геолокационная стратегия в реальном мире.

## Стек

| Компонент | Технология |
|-----------|-----------|
| Frontend | `/public/index.html` (единый файл), Leaflet.js, Socket.io |
| Backend | Express + Socket.io, VPS `overthrow.ru:8443` |
| БД | PostgreSQL 16 (self-hosted), совместимый слой `lib/supabase.js` |
| Хостинг | VPS 138.124.87.99, PM2, Nginx, SSL :8443 |
| Telegram | Bot API + WebApp SDK |
| Репо | `github.com/unixnumber1/grid-wars-server.git` (единый) |
| Деплой | `git push server master:main` → front-watcher за 30с |

## Env
```
DATABASE_URL=postgresql://overthrow:...@localhost:5432/overthrow_db
BOT_TOKEN=
PORT=3000
```

---

## Структура файлов

```
server.js                  — Express + Socket.io + game loops
ecosystem.config.cjs       — PM2 конфиг

/config
  constants.js             — ВСЕ константы игры (радиусы, лимиты, КД, цены)
  formulas.js              — доход, стоимость, HP, XP формулы

/game
  /state
    GameState.js            — in-memory state (все Maps + dirty tracking)
    persist.js              — batch upsert каждые 30с
  /loop
    gameLoop.js             — 5с тик: боты, курьеры, cleanup, ore income
  /mechanics
    bots.js                 — типы ботов, генерация
    clans.js                — уровни кланов, бонусы, зоны
    collectors.js           — автосборщики, уровни, авто-сбор
    cores.js                — типы ядер, множители, стоимости
    items.js                — предметы: статы, генерация, апгрейд, крафт
    market.js               — маркет: Overpass спавн, поиск локаций
    monuments.js            — рейд-боссы: спавн, защитники, лут, сброс
    oreNodes.js             — рудники: спавн, зоны, кластеры
    vases.js                — вазы: спавн для штабов
    xp.js                   — XP награды, начисление уровней

/api
  /middleware
    auth.js                 — проверка telegram_id
    validate.js             — валидация запросов
    ban.js                  — проверка бана
  /routes                   — API эндпоинты (новое расположение)
    player.js               — init/location/pvp-attack/pvp-flee
    map.js                  — GET map / POST tick
    buildings.js            — HQ place/upgrade/sell, mine build/upgrade/hit/sell
    items.js                — equip/unequip/sell/open-box/craft/upgrade-item
    market.js               — listings/buy/list-item/cancel/attack-courier
    bots.js                 — attack
    vases.js                — spawn/break
    clan.js                 — build-hq/create/join/leave/donate/upgrade
    admin.js                — reward/ban/unban/maintenance
    monuments.js            — raid actions
    collectors.js           — build/upgrade/deliver/sell/hit
    ore.js                  — capture/hit/switch-currency
    cores.js                — install/uninstall/upgrade/inventory
    economy.js              — (stub) collect
    shop.js                 — (stub) star payments

/security
  antispoof.js              — GPS антиспуф (MAX_SPEED 120 км/ч, автобан)
  rateLimit.js              — rate limiting по telegram_id
  validate.js               — валидация telegram_id, координат, XSS

/socket
  events.js                 — socket helpers (pushToPlayer, pushToNearby)

/lib                        — утилиты + обратная совместимость (re-exports)
  supabase.js               — PostgreSQL QueryBuilder (Supabase-compatible API)
  h3.js                     — H3 hex grid (resolution 10, переименован из grid.js)
  grid.js                   — re-export из h3.js
  haversine.js              — расстояние между координатами
  logger.js                 — логирование действий игроков
  log.js                    — dev-only лог
  format.js                 — форматирование чисел

/routes                     — re-exports из api/routes/ (обратная совместимость)

/tests
  /mechanics
    formulas.test.js         — тесты формул (доход, HP, стоимость)
    cores.test.js            — тесты ядер (множители, стоимость)
    items.test.js            — тесты предметов (генерация, апгрейд)
  smoke.js                   — smoke тест

/public
  index.html                 — единый фронтенд (HTML+CSS+JS)

/scripts
  front-watcher.js           — автодеплой (git pull каждые 30с)
  test-smoke.js              — smoke tests
  wipe-buildings.js          — вайп с компенсацией
```

---

## БД (PostgreSQL)

| Таблица | Назначение |
|---------|-----------|
| `players` | telegram_id, coins(BIGINT), diamonds, ether(BIGINT), level, xp, hp, clan_id |
| `headquarters` | player_id, lat, lng, cell_id, level(1-10) |
| `mines` | owner_id, lat, lng, cell_id, level(0-200), hp, status, last_collected |
| `items` | owner_id, type(sword/axe/shield), rarity, attack, crit_chance, equipped |
| `cores` | owner_id, mine_cell_id, slot_index(0-9), core_type, level(0-100) |
| `bots` | type, lat, lng, hp, status, target_mine_id, expires_at |
| `vases` | lat, lng, diamonds_reward, expires_at, broken_by |
| `markets` | lat, lng, name |
| `market_listings` | item_id, seller_id, price_diamonds, status, expires_at |
| `couriers` | type, owner_id, current/target lat/lng, hp, status |
| `courier_drops` | item_id, lat, lng, drop_type, expires_at |
| `ore_nodes` | lat, lng, level, owner_id, currency(shards/ether), expires_at |
| `clans` | name, symbol, color, level(1-10), treasury(BIGINT), leader_id |
| `clan_members` | clan_id, player_id, role(leader/officer/member) |
| `clan_headquarters` | player_id, clan_id, lat, lng, cell_id |
| `monuments` | lat, lng, level(1-10), name, hp, shield_hp, phase(shield/open/defeated) |
| `monument_defenders` | monument_id, emoji, hp, attack, wave, lat, lng, alive |
| `monument_loot_boxes` | monument_id, player_id, box_type, gems, items(JSONB) |
| `collectors` | owner_id, lat, lng, level(1-10), hp, stored_coins(BIGINT) |
| `notifications` | player_id, type, message, data(JSONB), read |
| `pvp_cooldowns` | attacker_id, defender_id, expires_at |
| `pvp_log` | attacker_id, defender_id, winner_id, rounds(JSONB) |

---

## Архитектура

### In-Memory Game State (`game/state/GameState.js`)
- **Все чтения** — только из gameState (не из БД)
- Новые объекты → gameState → `markDirty()` → batch persist через 30с
- Критичные операции (деньги, PvP) → немедленная запись + gameState
- `loadFromDB()` при старте, fallback к прямым запросам если не загружен

### Batch Persist (`game/state/persist.js`)
- Каждые 30с dirty объекты → upsert в БД
- `persistNow()` — немедленная запись для критичных операций

### Game Loop (`game/loop/gameLoop.js`)
- 5с тик: движение ботов/курьеров, cleanup каждые 5мин
- Ore passive income (shards или ether в зависимости от currency)
- Бот/курьер движение — только здесь (не в handleTick)

### Боевая система
- Единая механика: POST → сервер считает урон → Socket.io emit снаряда
- КД оружия: sword 500ms, axe 700ms, без оружия 200ms
- `lastAttackTime` Map — rate limit атак per player
- Socket events: `projectile`, `mine:hp_update`, `pvp:hit`, `pvp:kill`

### Unified Tick (`POST /api/map action:tick`)
- Каждые 5с, возвращает всё состояние для viewport
- player, mines, bots, vases, couriers, markets, monuments, notifications, player_cores
- 0 DB запросов (всё из gameState)

---

## Игровые механики

### Зоны
- **200м** (SMALL_RADIUS): строить, улучшать, собирать, вазы
- **500м** (LARGE_RADIUS): атаковать ботов, PvP, атаковать шахты

### Экономика
- **Формула дохода**: `50 * level^2 / 3600` coins/sec (lv1=50/ч, lv100=500K/ч, lv200=2M/ч)
- **Буст от шахт**: +0.1% за каждую шахту (1000 шахт = x2)
- Монеты BIGINT, optimistic locking
- Стартовый бонус: 100K монет + 100 алмазов
- H3 resolution: 10 (~65м гексы)

### Валюты
| Валюта | Источник | Использование |
|--------|---------|--------------|
| Монеты | Шахты, PvP | Постройки, улучшения |
| Алмазы | Боксы, вазы, ежедневный бонус, Stars | Сборщики, маркет, клан |
| Осколки | Рудники (currency=shards) | Прокачка оружия |
| Эфир | Рудники (currency=ether) | Прокачка ядер |

### Шахты
- Уровень 0-200, доход по формуле `50 * level^2`
- Вместимость: доход * hours (6ч до lv50, до 480ч на lv200+)
- HP: `getMineHp(level)`, реген 25%/ч
- Статусы: normal -> under_attack -> burning (24ч) -> destroyed
- Постройка в точку тапа (не центр гекса), cell_id вычисляется

### Ядра (`game/mechanics/cores.js`)
- 4 типа: доход, вместимость, HP, реген
- 10 слотов на шахту, множители складываются аддитивно
- Множитель: lv0=x1.5, lv10=x21.2, lv50=x62.1, lv100=x100
- Прокачка за эфир (100-53000 за уровень)
- Дроп с монументов: 2-40% шанс по уровню
- API: `POST /api/cores` action: install/uninstall/upgrade/inventory

### Рудники (`game/mechanics/oreNodes.js`)
- НЕ привязаны к штабам
- Спавн: кластеры 5км, 2-3 на игрока
- Ресет: 1-е число каждого месяца 00:00 МСК
- Автоспавн при старте если мало (<10% от ожидаемых)
- Выбор валюты: shards или ether (при захвате и через switch-currency)

### Предметы
- 3 типа: sword (attack+crit), axe (attack*1.4), shield (defense/HP)
- 6 редкостей: common -> uncommon -> rare -> epic -> mythic -> legendary
- Крафт: 10 одной редкости -> 1 следующей
- Экипировка: 1 оружие + 1 щит

### Гоблины
- Единственный моб: Гоблин-вор
- Состояния: roaming -> aggro (к шахте 500м) -> fleeing (с добычей)
- HP: 50, атака: 15, награда: 1-3 алмаза + 75 XP
- Ночью (0-6 МСК): x1.5 спавн, 70% агрессия

### PvP
- Реал-тайм удары, щит 2мин после смерти, КД 30мин
- Проигравший теряет 10% монет -> 50% победителю

### Кланы
- Штаб клана: 10М монет, маркер
- 10 уровней: бусты дохода 5-30%, защиты 10-75%, радиус 75-300м
- Буст дохода: x2-x6.5 на 24ч за алмазы из казны
- Роли: leader, officer, member
- Автопередача лидерства при 7 днях неактивности
- Продажа штаба клана доступна даже из клана

### Монументы (рейд-боссы)
- Спавн: Overpass API, городская инфраструктура, 3 на кластер
- 10 уровней: HP 30K-20M, щит 5K-2.5M
- Фазы: shield -> open (защитники) -> defeated (7 дней респавн)
- Open >4ч без слома -> полная регенерация
- Лут: пропорционально урону, trophy/gift, гемы + предметы + ядра
- Еженедельный ресет: воскресенье 00:00 МСК

### Автосборщики
- 75 алмазов, автосбор каждый час с шахт в 200м
- 10 уровней: вместимость 6ч-48ч, HP 3K-90K
- Доставка курьером, 10% комиссия
- PvP: уничтожение -> все монеты атакующему

### Маркет
- Торговля предметами за алмазы, 10% комиссия
- Автоспаун рынков через Overpass API (5км от игрока)
- Курьеры на карте, PvP перехват

---

## UI

### Тема
- Тёмная (#0d0d0d), Segoe UI / system-ui
- Попапы: card-based, фон #1a1a2e, карточки #252538, кнопки radius 12px
- `openPopup(title, subtitle, stats, actions)` -> рендер в popup-card

### Навигация
- **Хедер**: монеты * доход/ч | алмазы | осколки | эфир
- **Правая панель**: PIN, магазин, рынок, лидерборд, настройки
- **Низ**: аватар + ник/уровень/XP бар + кнопка Собрать

### Инвентарь (экран персонажа)
- Вкладки: Снаряжение / Ядра
- Снаряжение: сетка 4 колонки, mass sell, крафт
- Ядра: сетка 4 колонки, тап -> попап с прокачкой

### Hex сетка
- Видна при zoom >= 17 (~300м горизонтально)
- Клик на пустую клетку -> меню постройки
- Клик на клетку с постройкой -> мигание сетки (попап через маркер)
- Клик вне зоны -> ничего

### Z-Index (Leaflet)
- 10000: Игрок | 5000: Другие игроки | 4000: Боты, курьеры, защитники
- 3000: Монументы, рынки | 2000: Рудники, вазы | 1000: Шахты, штабы

---

## Безопасность

### Nginx
- Rate limit: API 30r/m + burst=20, WS 5r/s + burst=10
- 20 соединений/IP, body 1m, таймауты 10/30с
- Fail2ban: nginx-limit-req (10->бан 1ч), sshd (5->бан 24ч)

### Express
- `security/validate.js` — валидация telegram_id, координат, XSS-очистка
- `security/antispoof.js` — GPS антиспуф (MAX_SPEED 120 км/ч, автобан после 5 нарушений)
- `express.json({ limit: '100kb' })`

---

## Деплой

### Маршрут
1. Редактировать локально
2. `git add . && git commit && git push server master:main`
3. front-watcher подхватит за 30с, pm2 restart при изменении бэкенда

### Git remotes
- `server` -> `github.com/unixnumber1/grid-wars-server.git` (основной)

### Запрещено
- Копировать файлы через SCP (front-watcher затрёт)
- Редактировать на VPS напрямую
- `pm2 restart all` (ломает front-watcher, использовать `pm2 restart grid-wars`)

---

## Админ
- ADMIN_TG_ID: 560013667
- Джойстик перемещения (3 скорости)
- Панель: ресурсы, бан/разбан, рынки, maintenance, webhook

---

## Железные правила (НЕЛЬЗЯ нарушать)

### 1. Роут не содержит логику
```js
// НЕЛЬЗЯ:
router.post('/', async (req, res) => {
  const mine = gameState.mines.get(cellId)
  mine.level++
  await supabase.from('mines').update(...)
  res.json({ ok: true })
})

// МОЖНО:
router.post('/', async (req, res) => {
  const result = await buildingsMechanics.handleAction(req.body, req.player)
  res.json(result)
})
```

### 2. Все чтения из gameState
```js
// НЕЛЬЗЯ:
const { data } = await supabase.from('mines').select('*')

// МОЖНО:
const mine = gameState.mines.get(cellId)
```

### 3. Константы только в config/constants.js
```js
// НЕЛЬЗЯ:
const RADIUS = 200 // в роуте или механике

// МОЖНО:
import { SMALL_RADIUS } from '../../config/constants.js'
```

### 4. Новая механика = новый файл в game/mechanics/
Не добавлять новую логику в существующие файлы если она относится к другой механике.

### 5. Новая постройка/предмет = запись в config/
Не хардкодить характеристики в механиках.

### 6. После изменений запускать тесты
```
node --test tests/mechanics/*.test.js
```

### 7. Деплой только через git push
Не редактировать файлы напрямую на VPS.

### 8. upgrade_level всегда включать при SELECT/UPDATE items
### 9. Постройки ставятся в координаты тапа (не центр гекса)
### 10. Новые эндпоинты: gameState -> emit -> markDirty
### 11. Критичные операции -> немедленная запись в БД
