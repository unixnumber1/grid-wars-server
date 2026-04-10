# UI/UX Audit — Grid Wars Frontend

## Критические проблемы

### 1. Несогласованные border-radius
- **`.btn`** использует `border-radius: 10px` (line 300), но CSS-переменная `--btn-radius: 12px` (line 47). Должно быть 12px.
- **`.popup-stat`** — `border-radius: 10px` (line 358), остальные карточки используют 12px.
- **`.burger-item`** — `border-radius: 10px` (line 144), остальные HUD кнопки 12px.
- **`.settings-card`** — `border-radius: 10px` (line 542), остальные карточки 12px.

### 2. Цветовые выбросы из темы
- **`.btn-back`** — `color: #4488ff` (line 726). Нет такого цвета в теме. Должен быть `var(--btn-primary)` (#2196f3) или #fff.
- **`.inv-main-tab.active`** — `border-color: #4488ff` (line 1550). Тот же чужой синий. В остальном UI акцент = #FFD700 или #2196f3.
- **`.profile-overlay`** — `background: #0a0a1a` (line 715). Остальные fullscreen overlays используют #1a1a2e (settings) или #0d0d0d (profile-modal). Три разных фона для fullscreen экранов.
- **`#profile-modal`** — `background: #0d0d0d` (line 1373). Profile overlay = #0a0a1a. Settings = #1a1a2e. Нужно унифицировать.
- **Build items** используют `background: #111` (line 742, 747), profile-stats `background: #111` — не совпадает с `var(--card-bg)` (#252538).

### 3. Popup subtitle слишком тёмная
- **`#popup-card .subtitle`** — `color: #666` (line 350). Очень трудно прочесть на тёмном фоне #1a1a2e. Должна быть минимум #888 (`var(--text-secondary)`).

### 4. Build menu стиль не совпадает
- **`.build-card`** — `background: #1a1a1a; border: 1px solid #2a2a2a` (line 829). Это единственный компонент с этим оттенком, не совпадает ни с `--popup-bg` (#1a1a2e) ни с `--card-bg` (#252538).

### 5. Z-index конфликты
- **`#profile-modal`** = 8000 но **`#item-detail-overlay`** тоже = 8000 (line 1694). Детальный оверлей предметов может не перекрывать profile-modal.
- **`#core-detail-overlay`** = 9100, что выше popup-overlay (9000). Core detail может перекрыть попап.

### 6. Toast overflow на узких экранах
- **`#toast-container`** — `max-width: 260px` (line 400). Нет `word-wrap: break-word`, длинные сообщения обрезаются.

### 7. Нет safe-area-inset для fullscreen overlays
- **`#ban-screen`** — НЕТ safe-area-inset-top. На iPhone с нотчем контент под вырезом.
- **`#maintenance-screen`** — НЕТ safe-area-inset.
- **`#session-kicked-screen`** — НЕТ safe-area-inset.

---

## UX проблемы

### 8. Три разных паттерна fullscreen overlay
- **Settings**: фон #1a1a2e, header+tabs+body
- **Profile modal**: фон #0d0d0d, slide-up анимация
- **Profile overlay**: фон #0a0a1a, нет анимации
- **Leaderboard**: фон #1a1a2e, как settings

Нет единого компонента.

### 9. Кнопки закрытия не унифицированы
- Settings: ✕ (20px, color #888)
- Profile modal: ✕ (20px, color #888)
- Leaderboard: ← стрелка
- Profile overlay: текст "Назад" (color #4488ff)
- Popup: кнопка "Закрыть" внизу

### 10. Inventory tabs ≠ Settings tabs
- **Settings tabs**: text underline, gold accent (#FFD700)
- **Inventory tabs** `.inv-main-tab`: card-style, blue border (#4488ff)

Два визуальных языка для табов.

### 11. Stat rows — два стиля
- Попапы `.popup-stat`: `background: #252538`
- Profile overlay: `background: #111`

### 12. Rarity CSS с `!important` everywhere
Все `.rarity-*` классы (line 1665-1670) переопределяют с `!important`. Хрупко, затрудняет кастомизацию.

### 13. Level selector — синий акцент вместо золотого
`.level-option.selected` (line 552) — `background: #2196f3`. Весь остальной UI использует #FFD700 для выделения.

### 14. Disabled кнопки — только opacity
`.btn:disabled` — `opacity: 0.4`, нет визуальной разницы кроме прозрачности. На мобиле `cursor: not-allowed` не видно.

---

## Мелкие недочёты

### 15. Хардкод цветов вместо CSS-переменных
- `#333`, `#222`, `#111`, `#444` повсюду для бордеров. Должны быть `var(--border-*)`.
- font-size скачет (11-16px) без типографической системы.

### 16. Walk milestone кнопка — border-radius: 6px
`.walk-ms-btn` (line 1059) — `border-radius: 6px`. Остальные кнопки 10-12px.

### 17. Streak day7 — фиолетовый вне палитры
`.streak-card.day7` (line 942) — `background: #2a1a3e`. Фиолетовый нигде больше в дизайне.

### 18. CTA кнопки — два стиля
- Bottom panel "Собрать": ghost button (border + fill зелёный)
- Popup actions: solid dark fill

### 19. HP bar стиль различается
- Маркер на карте: `28px × 3px`
- В попапе: inline `height:8px`

### 20. Build card background — уникальный оттенок
`.build-card` (line 829) — `background: #1a1a1a` не совпадает ни с `--popup-bg` ни с `--card-bg`.

---

## Приоритеты

**P0 (быстро фиксится, сразу заметно):**
- #1 — border-radius 10px → 12px (4 правки)
- #2 — #4488ff → #2196f3 или #FFD700 (2 правки)
- #3 — subtitle #666 → #888 (1 правка)

**P1 (важно для UX):**
- #5 — z-index конфликты
- #6 — toast word-wrap
- #7 — safe-area-inset для ban/maintenance
- #10 — унифицировать табы

**P2 (дизайн-система):**
- #4, #8, #11, #15, #20 — единые фоны/бордеры
- #9 — единый паттерн закрытия
- #12 — убрать !important с rarity
