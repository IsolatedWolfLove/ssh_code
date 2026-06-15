import {
  ChevronRight,
  Folder,
  FolderOpen,
  Home,
  LoaderCircle,
  MoveUp,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

import type { RemoteDirectoryEntry } from '../../../shared/contracts';

interface FolderPickerDialogProps {
  initialPath: string;
  homePath: string;
  isBusy: boolean;
  onReadDirectory: (remotePath: string) => Promise<RemoteDirectoryEntry[]>;
  onCancel: () => void;
  onConfirm: (remotePath: string) => void;
}

interface PathSegment {
  label: string;
  path: string;
}

function normalizeRemotePath(remotePath: string): string {
  const trimmed = remotePath.trim();
  if (trimmed === '' || trimmed === '/') {
    return '/';
  }

  return `/${trimmed.split('/').filter(Boolean).join('/')}`;
}

function getParentPath(remotePath: string): string | null {
  const normalizedPath = normalizeRemotePath(remotePath);
  if (normalizedPath === '/') {
    return null;
  }

  const parentPath = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
  return parentPath === '' ? '/' : parentPath;
}

function buildPathSegments(remotePath: string): PathSegment[] {
  const normalizedPath = normalizeRemotePath(remotePath);
  const parts = normalizedPath.split('/').filter(Boolean);
  const segments: PathSegment[] = [{ label: '/', path: '/' }];
  let currentPath = '';

  for (const part of parts) {
    currentPath = `${currentPath}/${part}`;
    segments.push({
      label: part,
      path: currentPath,
    });
  }

  return segments;
}

export function FolderPickerDialog({
  initialPath,
  homePath,
  isBusy,
  onReadDirectory,
  onCancel,
  onConfirm,
}: FolderPickerDialogProps) {
  const titleId = useId();
  const [currentPath, setCurrentPath] = useState(() => normalizeRemotePath(initialPath));
  const [entries, setEntries] = useState<RemoteDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const parentPath = getParentPath(currentPath);
  const directories = useMemo(
    () => entries.filter((entry) => entry.kind === 'directory'),
    [entries],
  );
  const pathSegments = useMemo(() => buildPathSegments(currentPath), [currentPath]);
  const normalizedHomePath = normalizeRemotePath(homePath);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setErrorMessage(null);

    void onReadDirectory(currentPath)
      .then((nextEntries) => {
        if (!active) {
          return;
        }

        setEntries(nextEntries);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : `Unable to read ${currentPath}`;
        setEntries([]);
        setErrorMessage(message);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [currentPath, onReadDirectory, reloadKey]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !isBusy) {
        onCancel();
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [isBusy, onCancel]);

  function enterPath(remotePath: string): void {
    if (isBusy || loading) {
      return;
    }

    setCurrentPath(normalizeRemotePath(remotePath));
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isBusy) {
          onCancel();
        }
      }}
    >
      <div className="dialog-card folder-picker-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-header">
          <div>
            <h2 id={titleId}>Open Folder</h2>
            <p>{currentPath}</p>
          </div>
          <button
            type="button"
            className="icon-button dialog-close-button"
            aria-label="Close dialog"
            onClick={onCancel}
            disabled={isBusy}
          >
            <X size={16} />
          </button>
        </div>

        <div className="folder-picker-toolbar">
          <button
            type="button"
            className="icon-button folder-picker-tool-button"
            onClick={() => {
              if (parentPath) {
                enterPath(parentPath);
              }
            }}
            disabled={!parentPath || isBusy || loading}
            title="Parent folder"
            aria-label="Parent folder"
          >
            <MoveUp size={16} />
          </button>
          <button
            type="button"
            className="icon-button folder-picker-tool-button"
            onClick={() => {
              enterPath(normalizedHomePath);
            }}
            disabled={currentPath === normalizedHomePath || isBusy || loading}
            title="Home folder"
            aria-label="Home folder"
          >
            <Home size={16} />
          </button>
          <button
            type="button"
            className="icon-button folder-picker-tool-button"
            onClick={() => {
              setReloadKey((previous) => previous + 1);
            }}
            disabled={isBusy || loading}
            title="Refresh folder"
            aria-label="Refresh folder"
          >
            <RefreshCw size={16} />
          </button>

          <nav className="folder-picker-breadcrumbs" aria-label="Current folder">
            {pathSegments.map((segment, index) => (
              <div className="folder-picker-breadcrumb-item" key={segment.path}>
                {index > 0 ? <ChevronRight size={13} /> : null}
                <button
                  type="button"
                  className="folder-picker-breadcrumb-button"
                  onClick={() => {
                    enterPath(segment.path);
                  }}
                  disabled={segment.path === currentPath || isBusy || loading}
                  title={segment.path}
                >
                  {segment.label}
                </button>
              </div>
            ))}
          </nav>
        </div>

        <div className="folder-picker-list" aria-busy={loading}>
          {loading ? (
            <div className="folder-picker-state">
              <LoaderCircle className="spin" size={16} />
              <span>Loading folders</span>
            </div>
          ) : errorMessage ? (
            <div className="folder-picker-state folder-picker-error">{errorMessage}</div>
          ) : directories.length === 0 ? (
            <div className="folder-picker-state">No child folders</div>
          ) : (
            directories.map((entry) => (
              <button
                type="button"
                className="folder-picker-row"
                key={entry.path}
                onClick={() => {
                  enterPath(entry.path);
                }}
                disabled={isBusy}
                title={entry.path}
              >
                <Folder size={16} />
                <span>{entry.name}</span>
                <ChevronRight size={14} />
              </button>
            ))
          )}
        </div>

        <div className="folder-picker-selection">
          <FolderOpen size={16} />
          <span>{currentPath}</span>
        </div>

        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={isBusy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              onConfirm(currentPath);
            }}
            disabled={isBusy || loading || Boolean(errorMessage)}
          >
            {isBusy ? <LoaderCircle className="spin" size={16} /> : null}
            <span>Open Folder</span>
          </button>
        </div>
      </div>
    </div>
  );
}
