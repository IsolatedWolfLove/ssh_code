import type { ElectronApi } from '../../../shared/electron-api';

import electronApiImpl from './electron-api-impl';
import wailsApiImpl from './wails-api-impl';

/**
 * Single entry point App.tsx/TerminalPanel.tsx import instead of reaching
 * for window.electronAPI directly. Selects the Wails-backed implementation
 * when running inside a Wails webview (window.go is injected by
 * wailsjs/go/app/App.js's calls), otherwise falls back to the Electron
 * passthrough. The two builds never run at the same time, so this check
 * only needs to distinguish "am I in a Wails window or an Electron one."
 */
const isWailsRuntime = typeof window !== 'undefined' && Boolean((window as unknown as { go?: unknown }).go);

const api: ElectronApi = isWailsRuntime ? wailsApiImpl : electronApiImpl;

export default api;
