const { contextBridge, ipcRenderer } = require('electron');
const { optimizeSequence, analyzeEffectState, advanceSlotDetector } = require('./core.cjs');

contextBridge.exposeInMainWorld('desktopAPI', {
  listSources: () => ipcRenderer.invoke('capture:list'),
  getCatalog: () => ipcRenderer.invoke('catalog:get'),
  setAlwaysOnTop: value => ipcRenderer.invoke('settings:top', value),
  listHistory: () => ipcRenderer.invoke('history:list'),
  saveHistory: record => ipcRenderer.invoke('history:save', record),
  updateHistory: (id, changes) => ipcRenderer.invoke('history:update', id, changes),
  deleteHistory: id => ipcRenderer.invoke('history:delete', id),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  optimizeSequence: input => optimizeSequence(input),
  analyzeEffectState: input => analyzeEffectState(input),
  advanceSlotDetector: (previous, feature, now, cooldown) => advanceSlotDetector(previous, feature, now, cooldown)
});
