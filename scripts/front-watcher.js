import { exec } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const GH_TOKEN = process.env.GH_TOKEN;
const REPO = 'unixnumber1/grid-wars-front';
const BRANCH = 'main';
const CHECK_INTERVAL = 30000; // 30 sec
const DEST_DIR = '/var/www/grid-wars-server/public';

let lastSha = null;

async function checkForUpdates() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/commits/${BRANCH}`,
      {
        headers: {
          'Authorization': `token ${GH_TOKEN}`,
          'User-Agent': 'grid-wars-watcher',
        },
      }
    );
    if (!res.ok) {
      console.error('[watcher] GitHub API error:', res.status);
      return;
    }
    const data = await res.json();
    const sha = data.sha;

    if (!lastSha) {
      lastSha = sha;
      console.log('[watcher] Initial SHA:', sha.slice(0, 7));
      return;
    }

    if (sha !== lastSha) {
      console.log('[watcher] New commit:', sha.slice(0, 7), '-', data.commit?.message?.split('\n')[0]);
      lastSha = sha;
      syncFront();
    }
  } catch (e) {
    console.error('[watcher] Check error:', e.message);
  }
}

function syncFront() {
  const cloneUrl = GH_TOKEN
    ? `https://${GH_TOKEN}@github.com/${REPO}.git`
    : `https://github.com/${REPO}.git`;

  const cmd = [
    'rm -rf /tmp/grid-wars-front-sync',
    `git clone --depth 1 ${cloneUrl} /tmp/grid-wars-front-sync`,
    `mkdir -p ${DEST_DIR}`,
    `cp -r /tmp/grid-wars-front-sync/public/* ${DEST_DIR}/`,
    'rm -rf /tmp/grid-wars-front-sync',
  ].join(' && ');

  console.log('[watcher] Syncing frontend...');
  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      console.error('[watcher] Sync error:', err.message);
    } else {
      console.log('[watcher] Frontend synced successfully');
    }
  });
}

// First run — sync immediately
console.log('[watcher] Starting front-watcher, checking every', CHECK_INTERVAL / 1000, 'sec');
syncFront();

// Then poll for changes
setInterval(checkForUpdates, CHECK_INTERVAL);
