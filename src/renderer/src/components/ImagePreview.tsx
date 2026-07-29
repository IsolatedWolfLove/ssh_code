import { Maximize2, Minus, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export function getImageExtension(remotePath: string): string | null {
  const extension = remotePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(extension) ? extension : null;
}

export function isImagePath(remotePath: string): boolean {
  return getImageExtension(remotePath) !== null;
}

export function buildImageDataUrl(remotePath: string, base64: string): string {
  const extension = getImageExtension(remotePath) ?? 'png';
  return `data:${MIME_BY_EXTENSION[extension] ?? 'image/png'};base64,${base64}`;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

interface ImagePreviewProps {
  path: string;
  dataUrl: string;
  byteLength: number;
  modifiedAt?: number;
  isReloading: boolean;
  autoRefresh: boolean;
  onToggleAutoRefresh: (enabled: boolean) => void;
  onReload: () => void;
}

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/**
 * Viewer for remote images: result plots, sample frames, confusion matrices.
 * Zoom is stepped rather than continuous so repeated clicks land on
 * predictable factors, and 'fit' is the default because most outputs are
 * larger than the pane.
 */
export function ImagePreview({
  path,
  dataUrl,
  byteLength,
  modifiedAt,
  isReloading,
  autoRefresh,
  onToggleAutoRefresh,
  onReload,
}: ImagePreviewProps) {
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setNaturalSize(null);
  }, [path]);

  function stepZoom(direction: 1 | -1): void {
    const current = zoom === 'fit' ? 1 : zoom;
    const index = ZOOM_STEPS.findIndex((step) => step >= current - 0.001);
    const nextIndex = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (index === -1 ? 4 : index) + direction));
    setZoom(ZOOM_STEPS[nextIndex]);
  }

  return (
    <div className="image-preview">
      <div className="image-preview-toolbar">
        <span className="image-preview-meta">
          {naturalSize ? `${naturalSize.width} × ${naturalSize.height}` : 'Loading'} · {formatByteSize(byteLength)}
          {modifiedAt ? ` · ${new Date(modifiedAt).toLocaleTimeString()}` : ''}
        </span>

        <div className="image-preview-actions">
          <label className="toggle-row" title="Reload the image every few seconds to watch new output appear">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => {
                onToggleAutoRefresh(event.target.checked);
              }}
            />
            <span>Auto Refresh</span>
          </label>

          <button
            type="button"
            className="icon-button"
            title="Reload from the remote host"
            onClick={onReload}
          >
            <RefreshCw className={isReloading ? 'spin' : ''} size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Zoom out"
            onClick={() => {
              stepZoom(-1);
            }}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Fit to pane"
            onClick={() => {
              setZoom('fit');
            }}
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Zoom in"
            onClick={() => {
              stepZoom(1);
            }}
          >
            <Plus size={14} />
          </button>
          <span className="image-preview-zoom">{zoom === 'fit' ? 'fit' : `${Math.round(zoom * 100)}%`}</span>
        </div>
      </div>

      <div className={`image-preview-surface${zoom === 'fit' ? ' image-preview-surface-fit' : ''}`}>
        <img
          ref={imageRef}
          src={dataUrl}
          alt={path}
          className={zoom === 'fit' ? 'image-preview-image-fit' : 'image-preview-image'}
          style={zoom === 'fit' ? undefined : { width: naturalSize ? naturalSize.width * zoom : undefined }}
          onLoad={(event) => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
        />
      </div>
    </div>
  );
}
