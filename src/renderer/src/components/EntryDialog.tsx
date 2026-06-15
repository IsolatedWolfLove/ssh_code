import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';

interface EntryDialogProps {
  title: string;
  description: string;
  value: string;
  submitLabel: string;
  isBusy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function EntryDialog({
  title,
  description,
  value,
  submitLabel,
  isBusy,
  onChange,
  onCancel,
  onSubmit,
}: EntryDialogProps) {
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
      if (event.key === 'Escape' && !isBusy) {
        onCancel();
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [isBusy, onCancel]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isBusy) {
          onCancel();
        }
      }}
    >
      <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p>{description}</p>
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

        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label className="dialog-field">
            <span>Name</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => {
                onChange(event.target.value);
              }}
              disabled={isBusy}
            />
          </label>

          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={onCancel} disabled={isBusy}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={isBusy || value.trim() === ''}>
              {isBusy ? <LoaderCircle className="spin" size={16} /> : null}
              <span>{submitLabel}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
