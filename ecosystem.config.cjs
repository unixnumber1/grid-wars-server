module.exports = {
  apps: [
    {
      name: 'grid-wars',
      script: './server.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'front-watcher',
      script: './scripts/front-watcher.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production' },
    },
  ],
};
