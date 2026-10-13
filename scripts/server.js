'use strict';

// Runs the tabulation server without the Electron window, for development or
// for a headless host. The admin console is then at http://localhost:<port>/admin/.

const path = require('node:path');
const { startServer } = require('../src/server');

const dbPath = process.env.PERANGAT_DB || path.join(__dirname, '..', 'data', 'tabulation.sqlite');
const port = Number(process.env.PORT) || 3000;

startServer({ dbPath, port, host: '0.0.0.0' })
  .then((server) => {
    console.log(`Database:       ${dbPath}`);
    console.log(`Admin console:  ${server.localUrl}/admin/  (this computer only)`);
    for (const url of server.urls()) console.log(`Judges open:    ${url}`);

    const stop = () => server.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
