import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';

import type { SearchRemoteFilesResult } from '../../../shared/contracts';

interface SearchDialogProps {
  isBusy: boolean;
  query: string;
  caseSensitive: boolean;
  workspacePath: string;
  groupedResults: Array<[string, SearchRemoteFilesResult['matches']]>;
  resultCount: number;
  truncated: boolean;
  onChangeQuery: (value: string) => void;
  onToggleCaseSensitive: (value: boolean) => void;
  onClose: () => void;
  onRunSearch: () => void;
  onOpenMatch: (path: string, line: number, column: number) => void;
}

export function SearchDialog({
  isBusy,
  query,
  caseSensitive,
  workspacePath,
  groupedResults,
  resultCount,
  truncated,
  onChangeQuery,
  onToggleCaseSensitive,
  onClose,
  onRunSearch,
  onOpenMatch,
}: SearchDialogProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="dialog-card search-dialog-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-header">
          <div>
            <h2 id={titleId}>Global Search</h2>
            <p>{workspacePath}</p>
          </div>
          <button
            type="button"
            className="icon-button dialog-close-button"
            aria-label="Close search"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="search-controls">
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            onChange={(event) => {
              onChangeQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onRunSearch();
              }
            }}
            placeholder="Search in files"
          />
          <button
            type="button"
            className="icon-button search-run-button"
            onClick={onRunSearch}
            disabled={isBusy || query.trim() === ''}
            title="Run search"
          >
            {isBusy ? <RefreshCw className="spin" size={15} /> : <Search size={15} />}
          </button>
        </div>

        <div className="search-dialog-toolbar">
          <label className="toggle-row search-toggle-row">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => {
                onToggleCaseSensitive(event.target.checked);
              }}
            />
            <span>Case Sensitive</span>
          </label>
          <div className="search-dialog-summary">
            {isBusy ? (
              <>
                <LoaderCircle className="spin" size={14} />
                <span>Searching...</span>
              </>
            ) : query.trim() === '' ? (
              <span>Enter a query to search the current workspace.</span>
            ) : (
              <span>
                {resultCount} match{resultCount === 1 ? '' : 'es'}
                {truncated ? ' shown (truncated)' : ''}
              </span>
            )}
          </div>
        </div>

        <div className="search-results search-dialog-results">
          {groupedResults.length ? (
            groupedResults.map(([filePath, matches]) => (
              <div key={filePath} className="search-result-group">
                <div className="search-result-group-title">{filePath}</div>
                {matches.map((match) => (
                  <button
                    key={`${match.path}:${match.line}:${match.column}`}
                    type="button"
                    className="search-result-item"
                    onClick={() => {
                      onOpenMatch(match.path, match.line, match.column);
                    }}
                    title={`${match.path}:${match.line}:${match.column}`}
                  >
                    <span className="search-result-meta">Ln {match.line}, Col {match.column}</span>
                    <span className="search-result-preview">{match.preview}</span>
                  </button>
                ))}
              </div>
            ))
          ) : query.trim() !== '' && !isBusy ? (
            <div className="search-empty">No matches</div>
          ) : (
            <div className="search-empty">Search this workspace</div>
          )}
        </div>
      </div>
    </div>
  );
}
