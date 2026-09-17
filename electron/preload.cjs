const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, fn) => {
  const listener = (_event, value) => fn(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('localCode', Object.freeze({
  snapshot: () => ipcRenderer.invoke('app:snapshot'),
  addProject: () => ipcRenderer.invoke('project:add'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  models: () => ipcRenderer.invoke('models:list'),
  loadModel: key => ipcRenderer.invoke('models:load', key),
  unloadModel: id => ipcRenderer.invoke('models:unload', id),
  searchFiles: input => ipcRenderer.invoke('files:search', input),
  previewFile: input => ipcRenderer.invoke('files:preview', input),
  runChanges: (taskId, runId) => ipcRenderer.invoke('runs:changes', { taskId, runId }),
  previewRollback: (taskId, runId, path) => ipcRenderer.invoke('rollback:preview', { taskId, runId, path }),
  confirmRollback: token => ipcRenderer.invoke('rollback:confirm', token),
  submit: input => ipcRenderer.invoke('task:submit', input),
  stop: id => ipcRenderer.invoke('task:stop', id),
  approve: (taskId, approvalId, allow) => ipcRenderer.invoke('task:approve', { taskId, approvalId, allow }),
  onUpdate: fn => subscribe('app:update', fn),
  onDelta: fn => subscribe('task:delta', fn),
}));
