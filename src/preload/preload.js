'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SF', {
  init: () => ipcRenderer.invoke('sf:init'),
  patchConfig: (p) => ipcRenderer.invoke('sf:patchConfig', p),
  setPreset: (n) => ipcRenderer.invoke('sf:setPreset', n),
  setOpacity: (v) => ipcRenderer.invoke('sf:setOpacity', v),
  setAlwaysOnTop: (m) => ipcRenderer.invoke('sf:setAlwaysOnTop', m),
  setScreenGuard: (b) => ipcRenderer.invoke('sf:setScreenGuard', b),
  setSite: (id) => ipcRenderer.invoke('sf:setSite', id),
  addSite: (s) => ipcRenderer.invoke('sf:addSite', s),
  removeSite: (id) => ipcRenderer.invoke('sf:removeSite', id),
  hide: () => ipcRenderer.invoke('sf:hide'),
  quit: () => ipcRenderer.invoke('sf:quit'),
  openExternal: (u) => ipcRenderer.invoke('sf:openExternal', u),

  // 用户自己拖过尺寸之后，只按来源比例对齐高度
  fitRatio: (r) => ipcRenderer.invoke('sf:fitRatio', r),

  sync: (p) => ipcRenderer.send('sf:sync', p),
  setTitle: (t) => ipcRenderer.send('sf:title', t),
  onCmd: (fn) => {
    ipcRenderer.on('sf:cmd', (e, data) => fn(data));
  }
});
