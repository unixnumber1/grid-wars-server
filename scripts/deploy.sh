#!/bin/bash
cd /var/www/grid-wars-server
git pull origin main
npm install --production
pm2 restart all
sleep 5
node scripts/test-smoke.js
echo "✅ Deployed!"
