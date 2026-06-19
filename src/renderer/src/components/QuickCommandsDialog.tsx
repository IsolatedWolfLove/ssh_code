import { Play, Plus, TerminalSquare, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export interface QuickCommandItem {
  id: string;
  name: string;
  command: string;
}

interface QuickCommandsDialogProps {
  commands: QuickCommandItem[];
  isConnected: boolean;
  workspacePath: string;
  onAddCommand: (input: { name: string; command: string }) => void;
  onDeleteCommand: (commandId: string) => void;
  onRunCommand: (command: QuickCommandItem) => void;
  onClose: () => void;
}

function getDefaultCommandName(command: string): string {
  const firstLine = command.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine.slice(0, 48) : 'Quick Command';
}

export function QuickCommandsDialog({
  commands,
  isConnected,
  workspacePath,
  onAddCommand,
  onDeleteCommand,
  onRunCommand,
  onClose,
}: QuickCommandsDialogProps) {
  const titleId = useId();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [commandText, setCommandText] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
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

  function submitCommand(): void {
    const normalizedCommand = commandText.trim();
    if (normalizedCommand === '') {
      return;
    }

    onAddCommand({
      name: name.trim() || getDefaultCommandName(normalizedCommand),
      command: normalizedCommand,
    });
    setName('');
    setCommandText('');
    nameInputRef.current?.focus();
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="dialog-card quick-command-dialog-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-header">
          <div>
            <h2 id={titleId}>Quick Commands</h2>
            <p>{workspacePath}</p>
          </div>
          <button
            type="button"
            className="icon-button dialog-close-button"
            aria-label="Close quick commands"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="quick-command-list">
          {commands.length > 0 ? (
            commands.map((command) => (
              <div key={command.id} className="quick-command-row">
                <button
                  type="button"
                  className="quick-command-run"
                  disabled={!isConnected}
                  onClick={() => {
                    onRunCommand(command);
                  }}
                  title={command.command}
                >
                  <Play size={15} />
                  <span className="quick-command-copy">
                    <strong>{command.name}</strong>
                    <span>{command.command}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button quick-command-delete"
                  title={`Delete ${command.name}`}
                  onClick={() => {
                    onDeleteCommand(command.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          ) : (
            <div className="quick-command-empty">
              <TerminalSquare size={20} />
              <span>No quick commands yet</span>
            </div>
          )}
        </div>

        <div className="quick-command-form">
          <label className="dialog-field">
            <span>Name</span>
            <input
              ref={nameInputRef}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="Build vision"
            />
          </label>
          <label className="dialog-field">
            <span>Command</span>
            <textarea
              value={commandText}
              onChange={(event) => {
                setCommandText(event.target.value);
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  submitCommand();
                }
              }}
              placeholder="catkin_make -DCMAKE_BUILD_TYPE=Release"
            />
          </label>
          <button
            type="button"
            className="primary-button quick-command-add"
            disabled={commandText.trim() === ''}
            onClick={submitCommand}
          >
            <Plus size={16} />
            <span>Add Command</span>
          </button>
        </div>
      </div>
    </div>
  );
}
