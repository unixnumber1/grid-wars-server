module.exports = {
  apps: [
    {
      name: 'grid-wars',
      script: './server.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      autorestart: true,
      exp_backoff_restart_delay: 1000,
    },
    {
      name: 'front-watcher',
      script: './scripts/front-watcher.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production' },
    },
  ],
};
