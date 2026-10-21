const { contextBridge, ipcRenderer } = require('electron');
const { optimizeSequence, advanceSlotDetector } = require('./core.cjs');

contextBridge.exposeInMainWorld('desktopAPI', {
  listSources: () => ipcRenderer.invoke('capture:list'),
  getCatalog: () => ipcRenderer.invoke('catalog:get'),
  setAlwaysOnTop: value => ipcRenderer.invoke('settings:top', value),
  optimizeSequence: input => optimizeSequence(input),
  advanceSlotDetector: (previous, feature, now, cooldown) => advanceSlotDetector(previous, feature, now, cooldown)
});
