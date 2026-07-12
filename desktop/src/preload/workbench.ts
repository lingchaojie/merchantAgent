import { contextBridge, ipcRenderer } from "electron";

import {
  WorkbenchChannels,
  type WorkbenchAPI,
} from "../shared/connector-contract";

const api: WorkbenchAPI = {
  getEnrollment: () => ipcRenderer.invoke(WorkbenchChannels.enrollment),
  unlock: (encodedCredential) => ipcRenderer.invoke(WorkbenchChannels.unlock, { encodedCredential }),
  saveCredential: (sessionId, ref, credential) =>
    ipcRenderer.invoke(WorkbenchChannels.saveCredential, { sessionId, ref, credential }),
  saveDraft: (sessionId, draft) => ipcRenderer.invoke(WorkbenchChannels.saveDraft, { sessionId, draft }),
  testConnection: (sessionId, draftId) =>
    ipcRenderer.invoke(WorkbenchChannels.testConnection, { sessionId, draftId }),
  testOperation: (sessionId, draftId, tool, args) =>
    ipcRenderer.invoke(WorkbenchChannels.testOperation, { sessionId, draftId, tool, args }),
  closeResult: (sessionId, resultId) =>
    ipcRenderer.invoke(WorkbenchChannels.closeResult, { sessionId, resultId }),
  validateAndFreeze: (sessionId, draftId) =>
    ipcRenderer.invoke(WorkbenchChannels.validateAndFreeze, { sessionId, draftId }),
  submit: (sessionId, draftId) => ipcRenderer.invoke(WorkbenchChannels.submit, { sessionId, draftId }),
  lock: (sessionId) => ipcRenderer.invoke(WorkbenchChannels.lock, { sessionId }),
};

contextBridge.exposeInMainWorld("workbench", api);
