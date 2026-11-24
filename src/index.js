'use strict';

const path = require('path');
const { createApp } = require('./app');
const { Store } = require('./store');

const port = Number(process.env.PORT) || 3000;
const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set; sessions will reset on every restart.');
}

const store = new Store(dataFile);
const app = createApp({ store, secret: process.env.SESSION_SECRET, secureCookies: isProd });

app.listen(port, () => {
  console.log(`Ajaia Docs running at http://localhost:${port} (data: ${dataFile})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
