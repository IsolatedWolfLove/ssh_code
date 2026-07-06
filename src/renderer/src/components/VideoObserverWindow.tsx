import { useEffect, useRef, useState } from 'react';

import type { VideoFrameEvent, VideoStreamStateEvent } from '../../../shared/contracts';

interface VideoObserverWindowProps {
  streamId: string;
}

export function VideoObserverWindow({ streamId }: VideoObserverWindowProps) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<VideoStreamStateEvent['status']>('running');
  const [message, setMessage] = useState<string>('等待第一帧画面…');
  const [frameCount, setFrameCount] = useState(0);
  const frameUrlRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastContentSizeRef = useRef<string>('');

  useEffect(() => {
    const unsubscribeFrame = window.electronAPI.onVideoFrame((event: VideoFrameEvent) => {
      if (event.streamId !== streamId) {
        return;
      }

      const blob = new Blob([event.data as unknown as BlobPart], { type: 'image/jpeg' });
      const nextUrl = URL.createObjectURL(blob);
      const previousUrl = frameUrlRef.current;
      frameUrlRef.current = nextUrl;
      setFrameUrl(nextUrl);
      setFrameCount((count) => count + 1);
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
    });

    const unsubscribeState = window.electronAPI.onVideoStreamState((event: VideoStreamStateEvent) => {
      if (event.streamId !== streamId) {
        return;
      }

      setStatus(event.status);
      if (event.message) {
        setMessage(event.message);
      } else if (event.status === 'running') {
        setMessage('已连接，等待画面…');
      } else if (event.status === 'stopped') {
        setMessage('视频流已停止');
      }
    });

    return () => {
      unsubscribeFrame();
      unsubscribeState();
      if (frameUrlRef.current) {
        URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = null;
      }
    };
  }, [streamId]);

  // Note: we intentionally do NOT call stopVideoStream() from a React effect
  // cleanup here. The main process already stops the stream when this
  // window's native 'closed' event fires (see createVideoObserverWindow in
  // src/main/index.ts), which is the only reliable signal that the window is
  // actually gone. An effect-based cleanup would also fire during React
  // StrictMode's dev-mode mount/unmount/remount cycle, which would tear down
  // the stream (and close this window) immediately after opening it.

  function fitWindowToFrame(image: HTMLImageElement): void {
    const chromeHeight = Math.max(
      0,
      Math.ceil(window.innerHeight - (viewportRef.current?.clientHeight ?? image.clientHeight)),
    );
    const width = image.naturalWidth;
    const height = image.naturalHeight + chromeHeight;
    const key = `${width}x${height}`;
    if (width <= 0 || height <= 0 || key === lastContentSizeRef.current) {
      return;
    }

    lastContentSizeRef.current = key;
    void window.electronAPI.resizeVideoObserver(streamId, width, height).catch(() => undefined);
  }

  return (
    <div className="video-observer-window">
      <div className="video-observer-toolbar">
        <span className={`video-observer-status video-observer-status-${status}`}>
          {status === 'running' ? '● 直播中' : status === 'error' ? '● 错误' : '● 已停止'}
        </span>
        <span className="video-observer-frame-count">帧数: {frameCount}</span>
      </div>
      <div className="video-observer-viewport" ref={viewportRef}>
        {frameUrl ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img
            src={frameUrl}
            alt="Vision stream frame"
            className="video-observer-frame"
            onLoad={(event) => {
              fitWindowToFrame(event.currentTarget);
            }}
          />
        ) : (
          <div className="video-observer-placeholder">{message}</div>
        )}
      </div>
      {status === 'error' ? <div className="video-observer-error-banner">{message}</div> : null}
    </div>
  );
}
