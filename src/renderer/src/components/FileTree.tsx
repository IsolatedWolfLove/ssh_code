import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';

import type { RemoteDirectoryEntry } from '../../../shared/contracts';

interface FileTreeProps {
  workspacePath: string;
  entriesByDirectory: Record<string, RemoteDirectoryEntry[]>;
  expandedDirectories: Set<string>;
  loadingDirectories: Set<string>;
  activeFilePath: string | null;
  selectedPath: string | null;
  onSelectPath: (remotePath: string) => void;
  onToggleDirectory: (remotePath: string) => void;
  onOpenFile: (remotePath: string) => void;
  onRefreshDirectory: (remotePath: string) => void;
  onOpenContextMenu: (
    remotePath: string,
    kind: 'directory' | 'file',
    position: { x: number; y: number },
  ) => void;
}

interface VisibleTreeRow {
  depth: number;
  entry: RemoteDirectoryEntry;
}

const TREE_ROW_HEIGHT = 30;
const TREE_OVERSCAN = 8;

function buildVisibleRows(
  entriesByDirectory: Record<string, RemoteDirectoryEntry[]>,
  expandedDirectories: Set<string>,
  workspacePath: string,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  function append(entries: RemoteDirectoryEntry[], depth: number): void {
    for (const entry of entries) {
      rows.push({ depth, entry });

      if (entry.kind === 'directory' && expandedDirectories.has(entry.path)) {
        append(entriesByDirectory[entry.path] ?? [], depth + 1);
      }
    }
  }

  append(entriesByDirectory[workspacePath] ?? [], 0);
  return rows;
}

export const FileTree = memo(function FileTree({
  workspacePath,
  entriesByDirectory,
  expandedDirectories,
  loadingDirectories,
  activeFilePath,
  selectedPath,
  onSelectPath,
  onToggleDirectory,
  onOpenFile,
  onRefreshDirectory,
  onOpenContextMenu,
}: FileTreeProps) {
  const rootEntries = entriesByDirectory[workspacePath] ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const workspaceName =
    workspacePath === '/' ? '/' : workspacePath.split('/').filter(Boolean).pop() ?? workspacePath;
  const visibleRows = useMemo(
    () => buildVisibleRows(entriesByDirectory, expandedDirectories, workspacePath),
    [entriesByDirectory, expandedDirectories, workspacePath],
  );
  const totalHeight = visibleRows.length * TREE_ROW_HEIGHT;
  const visibleCount = viewportHeight > 0 ? Math.ceil(viewportHeight / TREE_ROW_HEIGHT) : visibleRows.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
  const endIndex = Math.min(
    visibleRows.length,
    startIndex + visibleCount + TREE_OVERSCAN * 2,
  );
  const windowedRows = visibleRows.slice(startIndex, endIndex);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const updateMeasurements = () => {
      setViewportHeight(element.clientHeight);
      setScrollTop(element.scrollTop);
    };

    updateMeasurements();

    const resizeObserver = new ResizeObserver(() => {
      updateMeasurements();
    });
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <section className="file-tree">
      <div className="section-heading">
        <span>Explorer</span>
        <button
          type="button"
          className="icon-button"
          onClick={() => onRefreshDirectory(workspacePath)}
          title="Refresh root"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="tree-workspace">
        <button
          type="button"
          className={`tree-workspace-button ${selectedPath === workspacePath ? 'tree-workspace-button-selected' : ''}`}
          onClick={() => onSelectPath(workspacePath)}
          onContextMenu={(event) => {
            event.preventDefault();
            onSelectPath(workspacePath);
            onOpenContextMenu(workspacePath, 'directory', { x: event.clientX, y: event.clientY });
          }}
          title={workspacePath}
        >
          <div className="tree-workspace-name">{workspaceName}</div>
          <div className="tree-root-label">{workspacePath}</div>
        </button>
      </div>

      <div
        className="tree-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        {loadingDirectories.has(workspacePath) && rootEntries.length === 0 ? (
          <div className="tree-loading">
            <LoaderCircle className="spin" size={15} />
            <span>Loading {workspacePath}</span>
          </div>
        ) : (
          <div className="tree-virtual-space" style={{ height: totalHeight }}>
            <div
              className="tree-virtual-window"
              style={{ transform: `translateY(${startIndex * TREE_ROW_HEIGHT}px)` }}
            >
              {windowedRows.map(({ depth, entry }) => (
                <TreeRow
                  key={entry.path}
                  entry={entry}
                  depth={depth}
                  expanded={entry.kind === 'directory' && expandedDirectories.has(entry.path)}
                  loading={entry.kind === 'directory' && loadingDirectories.has(entry.path)}
                  active={activeFilePath === entry.path}
                  selected={selectedPath === entry.path}
                  onSelectPath={onSelectPath}
                  onToggleDirectory={onToggleDirectory}
                  onOpenFile={onOpenFile}
                  onOpenContextMenu={onOpenContextMenu}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
});

interface TreeRowProps {
  entry: RemoteDirectoryEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  active: boolean;
  selected: boolean;
  onSelectPath: (remotePath: string) => void;
  onToggleDirectory: (remotePath: string) => void;
  onOpenFile: (remotePath: string) => void;
  onOpenContextMenu: FileTreeProps['onOpenContextMenu'];
}

const TreeRow = memo(function TreeRow({
  entry,
  depth,
  expanded,
  loading,
  active,
  selected,
  onSelectPath,
  onToggleDirectory,
  onOpenFile,
  onOpenContextMenu,
}: TreeRowProps) {
  const paddingLeft = 12 + depth * 14;

  return (
    <div className="tree-node">
      <button
        type="button"
        className={`tree-row ${active ? 'tree-row-active' : ''} ${selected ? 'tree-row-selected' : ''}`}
        style={{ paddingLeft }}
        onClick={() => {
          onSelectPath(entry.path);
          if (entry.kind === 'directory') {
            onToggleDirectory(entry.path);
            return;
          }

          onOpenFile(entry.path);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelectPath(entry.path);
          onOpenContextMenu(entry.path, entry.kind, { x: event.clientX, y: event.clientY });
        }}
        title={entry.path}
      >
        {entry.kind === 'directory' ? (
          <>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </>
        ) : (
          <>
            <span className="tree-spacer" />
            <FileCode2 size={15} />
          </>
        )}
        <span className="tree-label">{entry.name}</span>
        {loading ? <LoaderCircle className="spin tree-spinner" size={13} /> : null}
      </button>
    </div>
  );
});
