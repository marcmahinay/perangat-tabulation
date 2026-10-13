'use strict';

// Launches the Electron app. Used instead of calling `electron .` directly
// because some terminals (the VS Code integrated terminal among them) export
// ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node with no window.

const path = require('node:path');
const { spawn } = require('node:child_process');
const electronBinary = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => process.exit(code == null ? 1 : code));
