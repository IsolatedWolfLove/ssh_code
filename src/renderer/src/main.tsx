import React from 'react';
import ReactDOM from 'react-dom/client';

import './styles.css';
import '@xterm/xterm/css/xterm.css';

import { App } from './App';
import { initializeWindowFontScale } from './window-font-scale';

initializeWindowFontScale();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
