const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { createHistoryStore } = require('./history.cjs');

let mainWindow = null;
let historyStore = null;

function getHistoryStore() {
  if (!historyStore) {
    const file = process.env.DOKKAEBI_ANALYZER_HISTORY_FILE || path.join(app.getPath('userData'), 'measurement-history-v1.json');
    historyStore = createHistoryStore(file);
  }
  return historyStore;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#08110e',
    title: '도깨비 실전 분석기',
    icon: path.join(__dirname, '..', 'assets', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(
    path.join(__dirname, 'index.html'),
    process.env.DOKKAEBI_ANALYZER_DEMO === '1' ? { query: { demo: '1' } } : undefined
  );
}

const gotLock = process.env.DOKKAEBI_ANALYZER_ALLOW_MULTI === '1' || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow);
}

ipcMain.handle('capture:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  return sources
    .filter(source => source.name !== '도깨비 실전 분석기')
    .map(source => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id,
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : ''
    }));
});

ipcMain.handle('catalog:get', () => {
  const file = path.join(__dirname, '..', 'assets', 'data.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
});

ipcMain.handle('settings:top', (_event, value) => {
  if (!mainWindow) return false;
  mainWindow.setAlwaysOnTop(Boolean(value), 'floating');
  return mainWindow.isAlwaysOnTop();
});

ipcMain.handle('history:list', () => getHistoryStore().list());
ipcMain.handle('history:save', (_event, record) => getHistoryStore().save(record));
ipcMain.handle('history:update', (_event, id, changes) => getHistoryStore().update(id, changes));
ipcMain.handle('history:delete', (_event, id) => getHistoryStore().remove(id));
ipcMain.handle('app:version', () => app.getVersion());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
