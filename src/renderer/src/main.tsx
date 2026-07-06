import React from 'react';
import ReactDOM from 'react-dom/client';

import './styles.css';
import '@xterm/xterm/css/xterm.css';

import { App } from './App';
import { VideoObserverWindow } from './components/VideoObserverWindow';
import { initializeWindowFontScale } from './window-font-scale';

initializeWindowFontScale();

const VIDEO_OBSERVER_HASH_PREFIX = '#/video-observer/';

function renderRootView(): React.ReactElement {
  if (window.location.hash.startsWith(VIDEO_OBSERVER_HASH_PREFIX)) {
    const streamId = decodeURIComponent(window.location.hash.slice(VIDEO_OBSERVER_HASH_PREFIX.length));
    return <VideoObserverWindow streamId={streamId} />;
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{renderRootView()}</React.StrictMode>,
);
