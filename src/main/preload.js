'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only desktop capability pages get: saving the current page as a PDF.
contextBridge.exposeInMainWorld('desktop', {
  savePdf: (options) => ipcRenderer.invoke('pdf:save', options),
});
