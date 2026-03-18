import { execSync } from 'child_process';
import { copyFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_DIR = '/var/www/grid-wars-server';
const FRONT_SRC = join(PROJECT_DIR, 'public/index.html');
const FRONT_DEST = '/var/www/html/index.html';
const CHECK_INTERVAL = 30000; // 30 seconds

let lastHash = '';

function getCurrentHash() {
  try {
    return execSync('git rev-parse HEAD', { cwd: PROJECT_DIR }).toString().trim();
  } catch { return ''; }
}

function getCommitMessage(hash) {
  try {
    return execSync(`git log -1 --format=%s ${hash}`, { cwd: PROJECT_DIR }).toString().trim();
  } catch { return ''; }
}

function syncFrontend() {
  try {
    // Git pull (force reset to avoid conflicts from local edits)
    execSync('git fetch origin main && git reset --hard origin/main', { cwd: PROJECT_DIR, stdio: 'pipe' });

    const newHash = getCurrentHash();

    if (newHash && newHash !== lastHash) {
      const msg = getCommitMessage(newHash);
      console.log(`[watcher] Новый коммит: ${newHash.slice(0, 7)} — ${msg}`);

      // Copy frontend to /var/www/html/
      if (existsSync(FRONT_SRC)) {
        copyFileSync(FRONT_SRC, FRONT_DEST);
        console.log('[watcher] Фронт скопирован в', FRONT_DEST);
      }

      // Check if backend files changed — restart PM2 if so
      if (lastHash) {
        try {
          const diff = execSync(`git diff ${lastHash} ${newHash} --name-only`, { cwd: PROJECT_DIR }).toString();
          if (diff.includes('server.js') || diff.includes('routes/') || diff.includes('lib/') || diff.includes('socket/')) {
            execSync('pm2 restart grid-wars', { stdio: 'pipe' });
            console.log('[watcher] Сервер перезапущен (изменился бэкенд)');
          }
        } catch (e) {
          // If diff fails (e.g. force push), restart anyway
          execSync('pm2 restart grid-wars', { stdio: 'pipe' });
          console.log('[watcher] Сервер перезапущен (не удалось проверить diff)');
        }
      }

      lastHash = newHash;
    }
  } catch (err) {
    console.error('[watcher] Ошибка:', err.message);
  }
}

// Init
lastHash = getCurrentHash();
console.log(`[watcher] Запущен. Текущий коммит: ${lastHash.slice(0, 7)}`);
console.log(`[watcher] Репо: ${PROJECT_DIR}`);
console.log(`[watcher] Источник: ${FRONT_SRC}`);
console.log(`[watcher] Назначение: ${FRONT_DEST}`);

// First sync
syncFrontend();

// Periodic check
setInterval(syncFrontend, CHECK_INTERVAL);
