import { Editor, type OnMount } from '@monaco-editor/react';
import { RefreshCw } from 'lucide-react';

import type { EditorTabItem } from './EditorTabs';
import { monaco } from '../monaco';

interface RemoteEditorProps {
  isLoadingFile: boolean;
  language: string;
  tab: EditorTabItem;
  onChange: (nextContent: string | undefined) => void;
}

const EDITOR_OPTIONS = {
  automaticLayout: true,
  fontFamily: '"IBM Plex Mono", "JetBrains Mono", monospace',
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  tabSize: 2,
};

let themeDefined = false;

const handleMount: OnMount = (editor) => {
  if (!themeDefined) {
    monaco.editor.defineTheme('ssh-studio', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#111720',
        'editor.foreground': '#dbe7f2',
        'editorLineNumber.foreground': '#5c6b80',
        'editorLineNumber.activeForeground': '#dbe7f2',
        'editorCursor.foreground': '#3dd9c7',
        'editor.selectionBackground': '#214f63',
      },
    });
    themeDefined = true;
  }

  monaco.editor.setTheme('ssh-studio');
  editor.focus();
};

export function RemoteEditor({ isLoadingFile, language, tab, onChange }: RemoteEditorProps) {
  return (
    <Editor
      path={`ssh://${tab.connectionId}${tab.path}`}
      language={language}
      value={tab.content}
      onMount={handleMount}
      onChange={onChange}
      theme="ssh-studio"
      loading={
        <div className="editor-loading">
          <RefreshCw className={isLoadingFile ? 'spin' : ''} size={16} />
          <span>Loading editor</span>
        </div>
      }
      options={EDITOR_OPTIONS}
    />
  );
}

export default RemoteEditor;
