'use strict';

// The only surface the renderer gets. Everything is explicit and serialisable.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('fairyPi', {
  bootstrap: () => ipcRenderer.invoke('pi:bootstrap'),
  start: () => ipcRenderer.send('pi:start'),
  send: (record) => ipcRenderer.invoke('pi:send', record),
  restart: (options) => ipcRenderer.invoke('pi:restart', options),
  pickWorkdir: () => ipcRenderer.invoke('pi:pick-workdir'),
  listSessions: () => ipcRenderer.invoke('pi:sessions'),
  controlWindow: (action) => ipcRenderer.invoke('window:control', action),
  onRecord: (listener) => subscribe('pi:record', listener),
  onStatus: (listener) => subscribe('pi:status', listener),
  onStderr: (listener) => subscribe('pi:stderr', listener),
});
