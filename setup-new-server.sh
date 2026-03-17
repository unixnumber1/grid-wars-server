#!/bin/bash
# ═══════════════════════════════════════════════════════
#  Overthrow — Полная настройка нового VPS
#  Запуск: bash setup-new-server.sh
#  Полностью автономный — без интерактивных вопросов
# ═══════════════════════════════════════════════════════

export DEBIAN_FRONTEND=noninteractive
OLD_SERVER="93.123.30.179"
OLD_PASS="X3jthl2TfIbter"
PROJECT_DIR="/var/www/grid-wars-server"

passed=0; failed=0
ok()   { ((passed++)); echo "  ✅ $1"; }
fail() { ((failed++)); echo "  ❌ $1"; }
step() { echo ""; echo "═══ $1 ═══"; }

# ── 1. Базовые пакеты ──
step "1/12 Базовые пакеты"
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl git nginx ufw sshpass >/dev/null 2>&1
for pkg in curl git nginx sshpass; do
  dpkg -s $pkg >/dev/null 2>&1 && ok "$pkg" || fail "$pkg не установлен"
done

# ── 2. Node.js ──
step "2/12 Node.js"
if node --version 2>/dev/null | grep -q "^v2"; then
  ok "Node.js $(node --version) уже есть"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x 2>/dev/null | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi
node --version >/dev/null 2>&1 && ok "Node.js $(node --version)" || fail "Node.js"
npm --version >/dev/null 2>&1 && ok "npm $(npm --version)" || fail "npm"

# ── 3. PM2 ──
step "3/12 PM2"
if pm2 --version >/dev/null 2>&1; then
  ok "PM2 $(pm2 --version) уже есть"
else
  npm install -g pm2 >/dev/null 2>&1
  pm2 --version >/dev/null 2>&1 && ok "PM2 $(pm2 --version)" || fail "PM2"
fi

# ── 4. Репозитории ──
step "4/12 Клонирование"
mkdir -p /var/www
if [ -d "$PROJECT_DIR/.git" ]; then
  cd "$PROJECT_DIR" && git pull --ff-only 2>&1 | tail -1
  ok "grid-wars-server обновлён"
else
  git clone https://github.com/unixnumber1/grid-wars-server.git "$PROJECT_DIR" 2>&1 | tail -1
  ok "grid-wars-server клонирован"
fi
if [ -d "/var/www/grid-wars-front/.git" ]; then
  cd /var/www/grid-wars-front && git pull --ff-only 2>&1 | tail -1
  ok "grid-wars-front обновлён"
else
  git clone https://github.com/unixnumber1/grid-wars-front.git /var/www/grid-wars-front 2>&1 | tail -1
  ok "grid-wars-front клонирован"
fi

# ── 5. npm install ──
step "5/12 Зависимости"
cd "$PROJECT_DIR"
npm install --production 2>&1 | tail -3
[ -d node_modules ] && ok "node_modules ($(ls node_modules | wc -l) пакетов)" || fail "node_modules"

# ── 6. .env ──
step "6/12 Файл .env"
if [ -f "$PROJECT_DIR/.env" ] && grep -q "SUPABASE_URL" "$PROJECT_DIR/.env"; then
  ok ".env уже на месте"
else
  echo "  Копирую .env со старого сервера..."
  sshpass -p "$OLD_PASS" scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
    "root@$OLD_SERVER:/var/www/grid-wars-server/.env" "$PROJECT_DIR/.env" 2>/dev/null
  if [ -f "$PROJECT_DIR/.env" ] && grep -q "SUPABASE_URL" "$PROJECT_DIR/.env"; then
    ok ".env скопирован"
  else
    fail ".env — создай вручную! Нужны: SUPABASE_URL, SUPABASE_KEY, BOT_TOKEN"
    cat > "$PROJECT_DIR/.env" << 'ENVEOF'
SUPABASE_URL=
SUPABASE_KEY=
BOT_TOKEN=
PORT=3000
GH_TOKEN=
ENVEOF
  fi
fi
echo "  Переменные:" && grep -oP '^[A-Z_]+' "$PROJECT_DIR/.env" 2>/dev/null | sed 's/^/    /'

# ── 7. Фронтенд ──
step "7/12 Фронтенд"
mkdir -p "$PROJECT_DIR/public"
cp /var/www/grid-wars-front/public/index.html "$PROJECT_DIR/public/index.html" 2>/dev/null
[ -f "$PROJECT_DIR/public/index.html" ] && ok "index.html ($(wc -c < "$PROJECT_DIR/public/index.html") байт)" || fail "index.html"

# ── 8. Nginx ──
step "8/12 Nginx"
# Попробовать скопировать со старого сервера
sshpass -p "$OLD_PASS" scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
  "root@$OLD_SERVER:/etc/nginx/sites-available/overthrow" /etc/nginx/sites-available/overthrow 2>/dev/null

if [ ! -f /etc/nginx/sites-available/overthrow ]; then
  echo "  Создаю конфиг Nginx..."
  cat > /etc/nginx/sites-available/overthrow << 'NGEOF'
server {
    listen 8443 ssl;
    server_name overthrow.ru;
    ssl_certificate /etc/letsencrypt/live/overthrow.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/overthrow.ru/privkey.pem;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
server {
    listen 80;
    server_name overthrow.ru;
    return 301 https://overthrow.ru:8443$request_uri;
}
NGEOF
  ok "Nginx конфиг создан"
else
  ok "Nginx конфиг скопирован"
fi
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/overthrow /etc/nginx/sites-enabled/overthrow

# ── 9. SSL ──
step "9/12 SSL сертификаты"
sshpass -p "$OLD_PASS" scp -r -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
  "root@$OLD_SERVER:/etc/letsencrypt" /etc/ 2>/dev/null

if [ -f /etc/letsencrypt/live/overthrow.ru/fullchain.pem ]; then
  ok "SSL скопирован"
else
  fail "SSL — настрой после смены DNS: certbot --nginx -d overthrow.ru"
  # Временный конфиг без SSL
  cat > /etc/nginx/sites-available/overthrow << 'NGEOF'
server {
    listen 8443;
    server_name overthrow.ru _;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
NGEOF
  echo "  ⚠️ Временный конфиг без SSL"
fi
nginx -t 2>&1 && ok "nginx -t OK" || fail "nginx -t"
systemctl restart nginx 2>&1 && ok "nginx запущен" || fail "nginx"

# ── 10. PM2 ──
step "10/12 Запуск PM2"
cd "$PROJECT_DIR"
pm2 kill >/dev/null 2>&1
pm2 start server.js --name grid-wars --node-args="--env-file=.env" 2>&1 | tail -2
ok "grid-wars"
[ -f scripts/front-watcher.js ] && pm2 start scripts/front-watcher.js --name front-watcher 2>&1 | tail -1 && ok "front-watcher"
[ -f webhook.js ] && pm2 start webhook.js --name grid-wars-webhook 2>&1 | tail -1 && ok "webhook"
pm2 save >/dev/null 2>&1
STARTUP_CMD=$(pm2 startup 2>&1 | grep "sudo" | head -1)
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD" >/dev/null 2>&1
  ok "PM2 автозапуск настроен"
else
  pm2 startup >/dev/null 2>&1
  ok "PM2 startup"
fi
echo "  ⏳ Ожидание gameState (10 сек)..."
sleep 10

# ── 11. Firewall ──
step "11/12 Firewall"
ufw allow 22/tcp >/dev/null 2>&1
ufw allow 80/tcp >/dev/null 2>&1
ufw allow 443/tcp >/dev/null 2>&1
ufw allow 8443/tcp >/dev/null 2>&1
echo "y" | ufw enable >/dev/null 2>&1
ok "UFW (22, 80, 443, 8443)"

# ── 12. Smoke тест ──
step "12/12 Smoke тест"
if [ -f "$PROJECT_DIR/scripts/test-smoke.js" ]; then
  cd "$PROJECT_DIR"
  node scripts/test-smoke.js 2>&1
  [ $? -eq 0 ] && ok "Все тесты пройдены" || fail "Есть провалы"
else
  fail "test-smoke.js не найден"
fi

# ── Итог ──
echo ""
echo "═══════════════════════════════════════════"
pm2 status
echo "═══════════════════════════════════════════"
total=$((passed + failed))
echo ""
echo "  Результат: $passed/$total шагов ✅"
[ $failed -gt 0 ] && echo "  ⚠️  $failed шагов требуют внимания"
MY_IP=$(curl -s -4 ifconfig.me 2>/dev/null || echo "138.124.87.99")
echo ""
echo "  📋 Дальше:"
echo "  1. DNS: A запись overthrow.ru → $MY_IP"
echo "  2. Подожди 5-30 мин"
echo "  3. SSL: certbot --nginx -d overthrow.ru"
echo "  4. Техперерыв выкл:"
echo "     curl -s -X POST http://localhost:3000/api/admin \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"action\":\"maintenance-end\",\"telegram_id\":560013667}'"
echo ""
echo "═══════════════════════════════════════════"
