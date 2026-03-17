#!/bin/bash
echo "🚀 Запуск Overthrow..."
echo ""

# Проверить Node.js
echo -n "Node.js: "
node --version || { echo "❌ Node.js не найден"; exit 1; }

# Перейти в папку проекта
cd /var/www/grid-wars-server || { echo "❌ Папка не найдена"; exit 1; }

# Установить зависимости если нужно
echo "📦 Проверка зависимостей..."
npm install --production 2>&1 | tail -3

# Запустить PM2
echo ""
echo "🔄 Запуск PM2..."
pm2 resurrect 2>&1 || {
  echo "⚠️ resurrect не сработал, запускаю вручную..."
  pm2 start server.js --name grid-wars --node-args="--env-file=.env"
  pm2 start scripts/front-watcher.js --name front-watcher
}

# Подождать пока сервер загрузит gameState
echo ""
echo "⏳ Ожидание загрузки gameState (10 сек)..."
sleep 10

# Проверить статус PM2
echo ""
echo "📋 Статус процессов:"
pm2 status

# Запустить smoke тесты
echo ""
echo "🧪 Запуск smoke тестов..."
node scripts/test-smoke.js
TEST_EXIT=$?

if [ $TEST_EXIT -ne 0 ]; then
  echo ""
  echo "⚠️ Некоторые тесты провалились! Проверьте логи:"
  echo "   pm2 logs grid-wars --lines 30"
  echo ""
  echo "Техперерыв НЕ выключен. Выключите вручную после проверки:"
  echo "   curl -X POST http://localhost:3000/api/admin -H 'Content-Type: application/json' -d '{\"action\":\"maintenance-end\",\"telegram_id\":560013667}'"
  exit 1
fi

# Выключить техперерыв
echo ""
echo "🔓 Выключение техперерыва..."
curl -s -X POST http://localhost:3000/api/admin \
  -H "Content-Type: application/json" \
  -d '{"action":"maintenance-end","telegram_id":560013667}'
echo ""

echo ""
echo "✅ Сервер запущен! Техперерыв выключен."
echo ""
echo "📊 Последние логи:"
pm2 logs grid-wars --lines 10 --nostream
