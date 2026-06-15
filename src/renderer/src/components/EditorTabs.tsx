import { FilePenLine, Save, X } from 'lucide-react';

export interface EditorTabItem {
  id: string;
  connectionId: string;
  path: string;
  name: string;
  content: string;
  savedContent: string;
  isSaving: boolean;
  autosaveRevision: number;
}

interface EditorTabsProps {
  tabs: EditorTabItem[];
  activeTabId: string | null;
  currentConnectionId: string | null;
  autoSaveEnabled: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onSave: (tabId: string) => void;
}

export function EditorTabs({
  tabs,
  activeTabId,
  currentConnectionId,
  autoSaveEnabled,
  onSelect,
  onClose,
  onSave,
}: EditorTabsProps) {
  if (tabs.length === 0) {
    return (
      <div className="editor-empty">
        <FilePenLine size={28} />
        <h2>Open a remote file</h2>
        <p>Select a file from the SFTP tree to start editing.</p>
      </div>
    );
  }

  return (
    <div className="tab-strip">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const dirty = tab.content !== tab.savedContent;
        const stale = currentConnectionId !== null && currentConnectionId !== tab.connectionId;

        return (
          <div key={tab.id} className={`tab-item ${active ? 'tab-item-active' : ''}`}>
            <button type="button" className="tab-main" onClick={() => onSelect(tab.id)} title={tab.path}>
              <span className={`tab-status ${dirty ? 'tab-status-dirty' : ''}`}>{dirty ? '*' : ' '}</span>
              <span className="tab-name">{tab.name}</span>
              {stale ? <span className="tab-stale">stale</span> : null}
              {tab.isSaving ? <span className="tab-saving">{autoSaveEnabled ? 'autosaving' : 'saving'}</span> : null}
            </button>

            <button
              type="button"
              className="tab-icon-button"
              onClick={() => onSave(tab.id)}
              disabled={!dirty || tab.isSaving || stale}
              title="Save"
            >
              <Save size={13} />
            </button>

            <button type="button" className="tab-icon-button" onClick={() => onClose(tab.id)} title="Close">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
