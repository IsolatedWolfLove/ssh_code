import type { ElectronApi } from '../../../shared/electron-api';

/**
 * Thin passthrough to window.electronAPI, so App.tsx/TerminalPanel.tsx can
 * import a single `api` module (see ./api.ts) instead of reaching for
 * window.electronAPI directly. This file changes no behavior under the
 * Electron build: every call is forwarded verbatim.
 */
const electronApiImpl: ElectronApi = new Proxy({} as ElectronApi, {
  get(_target, property: string | symbol) {
    const api = window.electronAPI;
    const value = api[property as keyof ElectronApi];
    if (typeof value === 'function') {
      return value.bind(api);
    }
    return value;
  },
});

export default electronApiImpl;
