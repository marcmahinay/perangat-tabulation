'use strict';

// Electron main process: owns the SQLite file, runs the LAN server in-process
// and shows the admin console, which is just a page served by that server.

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { startServer } = require('../server');

const PRELOAD = path.join(__dirname, 'preload.js');

let server = null;
let mainWindow = null;

const isOwnPage = (url) => Boolean(server) && url.startsWith(`${server.localUrl}/`);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Perangat Tabulation',
    backgroundColor: '#f6f4fa',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`${server.localUrl}/admin/`);
}

// Every window, including print previews, is confined to the app's own pages:
// it cannot navigate away, open anything else, or embed other content.
app.on('web-contents-created', (createdEvent, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (!isOwnPage(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1200,
        height: 850,
        autoHideMenuBar: true,
        webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
      },
    };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isOwnPage(url)) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
});

// Lets a print view save itself as a PDF without going through the print dialog.
ipcMain.handle('pdf:save', async (event, options = {}) => {
  if (!isOwnPage(event.sender.getURL())) throw new Error('Not allowed.');

  const window = BrowserWindow.fromWebContents(event.sender);
  const name = path.basename(String(options.suggestedName || 'tabulation.pdf'));
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { saved: false };

  const pdf = await event.sender.printToPDF({
    landscape: Boolean(options.landscape),
    pageSize: 'A4',
    printBackground: true,
  });
  await fs.writeFile(filePath, pdf);
  return { saved: true, filePath };
});

async function boot() {
  const dbPath = process.env.PERANGAT_DB || path.join(app.getPath('userData'), 'tabulation.sqlite');
  const port = Number(process.env.PORT) || 3000;
  try {
    // 0.0.0.0 = listen on every network interface, so judges on the LAN can connect.
    server = await startServer({ dbPath, port, host: '0.0.0.0' });
  } catch (error) {
    dialog.showErrorBox('Perangat Tabulation could not start', error.stack || String(error));
    app.quit();
    return;
  }
  // The pages need no camera, microphone, location or notifications.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));

  console.log(`Database: ${dbPath}`);
  console.log(`Judges connect to: ${server.urls().join('  or  ') || '(no network found)'}`);
  createWindow();
}

// Two copies would fight over the port and the database, so allow only one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(boot);

  // The server lives in this process, so closing the window ends the session on every platform.
  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', () => {
    if (server) server.close();
    server = null;
  });
}
