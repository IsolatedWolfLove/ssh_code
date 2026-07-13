import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Client as SshClient, ClientChannel } from 'ssh2';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

import type {
  LanguageServerDiagnosticsEvent,
  LanguageServerDocumentChangeInput,
  LanguageServerDocumentInput,
  LanguageServerDocumentReference,
  LanguageServerFeatureInput,
  LanguageServerStateEvent,
  StartLanguageServerInput,
  StartLanguageServerResult,
} from '../shared/contracts';

type DiagnosticsListener = (event: LanguageServerDiagnosticsEvent) => void;
type StateListener = (event: LanguageServerStateEvent) => void;

interface InitializeResult {
  capabilities?: Record<string, unknown>;
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LanguageServerDiagnosticsEvent['diagnostics'];
}

interface LanguageServerSession {
  id: string;
  workspacePath: string;
  language: StartLanguageServerInput['language'];
  channel: ClientChannel;
  connection: MessageConnection;
  openedDocuments: Set<string>;
  stderr: string;
  closing: boolean;
}

const MAX_STDERR_LENGTH = 8192;
const SHUTDOWN_TIMEOUT_MS = 1500;

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeRemotePath(remotePath: string): string {
  const trimmed = remotePath.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error('Language server paths must be absolute');
  }
  return path.posix.normalize(trimmed);
}

export function remotePathToFileUri(remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  return `file://${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

export function fileUriToRemotePath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:' || parsed.hostname !== '') {
      return null;
    }
    return normalizeRemotePath(decodeURIComponent(parsed.pathname));
  } catch {
    return null;
  }
}

function buildServerCommand(input: StartLanguageServerInput): string {
  const workspacePath = normalizeRemotePath(input.workspacePath);
  const root = quoteForShell(workspacePath);

  if (input.language === 'typescript') {
    return [
      `cd -- ${root}`,
      'if [ -x ./node_modules/.bin/typescript-language-server ]; then',
      '  exec ./node_modules/.bin/typescript-language-server --stdio',
      'elif command -v typescript-language-server >/dev/null 2>&1; then',
      '  exec typescript-language-server --stdio',
      'else',
      "  echo 'typescript-language-server is not installed. Run: npm install -D typescript-language-server typescript' >&2",
      '  exit 127',
      'fi',
    ].join('\n');
  }

  throw new Error(`Unsupported language server: ${input.language satisfies never}`);
}

function waitForChannel(client: SshClient, command: string): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(channel);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

export class RemoteLanguageServerManager {
  private sessions = new Map<string, LanguageServerSession>();
  private diagnosticsListeners = new Set<DiagnosticsListener>();
  private stateListeners = new Set<StateListener>();

  onDiagnostics(listener: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(listener);
    return () => {
      this.diagnosticsListeners.delete(listener);
    };
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  async start(client: SshClient, input: StartLanguageServerInput): Promise<StartLanguageServerResult> {
    const workspacePath = normalizeRemotePath(input.workspacePath);
    const existing = [...this.sessions.values()].find(
      (session) => session.workspacePath === workspacePath && session.language === input.language && !session.closing,
    );
    if (existing) {
      return {
        sessionId: existing.id,
        workspacePath,
        language: existing.language,
      };
    }

    const sessionId = randomUUID();
    this.emitState({
      sessionId,
      workspacePath,
      language: input.language,
      status: 'starting',
      message: 'Starting remote TypeScript language server...',
    });

    let channel: ClientChannel | null = null;
    try {
      channel = await waitForChannel(client, buildServerCommand({ ...input, workspacePath }));
      const connection = createMessageConnection(
        new StreamMessageReader(channel),
        new StreamMessageWriter(channel),
        {
          error: (message) => console.error(`[language-server] ${message}`),
          warn: (message) => console.warn(`[language-server] ${message}`),
          info: (message) => console.info(`[language-server] ${message}`),
          log: (message) => console.log(`[language-server] ${message}`),
        },
      );
      const session: LanguageServerSession = {
        id: sessionId,
        workspacePath,
        language: input.language,
        channel,
        connection,
        openedDocuments: new Set(),
        stderr: '',
        closing: false,
      };
      this.sessions.set(sessionId, session);
      this.configureConnection(session);
      connection.listen();

      await connection.sendRequest<InitializeResult>('initialize', {
        processId: null,
        clientInfo: { name: 'SSH Studio', version: '0.2.1' },
        rootUri: remotePathToFileUri(workspacePath),
        workspaceFolders: [{ uri: remotePathToFileUri(workspacePath), name: path.posix.basename(workspacePath) || '/' }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: true },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            publishDiagnostics: { relatedInformation: true },
          },
        },
      });
      await connection.sendNotification('initialized', {});

      this.emitState({
        sessionId,
        workspacePath,
        language: input.language,
        status: 'ready',
        message: 'Remote TypeScript language server ready',
      });
      return { sessionId, workspacePath, language: input.language };
    } catch (error) {
      const session = this.sessions.get(sessionId);
      const stderr = session?.stderr.trim() ?? '';
      const message = stderr || getErrorMessage(error, 'Unable to start the remote language server');
      const unavailable = /not installed|not found|exit(?:ed)? with code 127/i.test(message);
      if (session) {
        await this.stopSession(session, false);
      } else if (channel) {
        channel.destroy();
      }
      this.emitState({
        sessionId,
        workspacePath,
        language: input.language,
        status: unavailable ? 'unavailable' : 'error',
        message,
      });
      throw new Error(message);
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    await this.stopSession(session, true);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.stopSession(session, false)));
  }

  async openDocument(input: LanguageServerDocumentInput): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const remotePath = normalizeRemotePath(input.remotePath);
    session.openedDocuments.add(remotePath);
    await session.connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: remotePathToFileUri(remotePath),
        languageId: input.languageId,
        version: input.version,
        text: input.text,
      },
    });
  }

  async changeDocument(input: LanguageServerDocumentChangeInput): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const remotePath = normalizeRemotePath(input.remotePath);
    if (!session.openedDocuments.has(remotePath)) {
      throw new Error(`Language document is not open: ${remotePath}`);
    }
    await session.connection.sendNotification('textDocument/didChange', {
      textDocument: { uri: remotePathToFileUri(remotePath), version: input.version },
      contentChanges: input.contentChanges,
    });
  }

  async saveDocument(input: LanguageServerDocumentReference): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const remotePath = normalizeRemotePath(input.remotePath);
    if (!session.openedDocuments.has(remotePath)) {
      return;
    }
    await session.connection.sendNotification('textDocument/didSave', {
      textDocument: { uri: remotePathToFileUri(remotePath) },
    });
  }

  async closeDocument(input: LanguageServerDocumentReference): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const remotePath = normalizeRemotePath(input.remotePath);
    if (!session.openedDocuments.delete(remotePath)) {
      return;
    }
    await session.connection.sendNotification('textDocument/didClose', {
      textDocument: { uri: remotePathToFileUri(remotePath) },
    });
  }

  async requestFeature(input: LanguageServerFeatureInput): Promise<unknown> {
    const session = this.requireSession(input.sessionId);
    const methodByFeature = {
      completion: 'textDocument/completion',
      hover: 'textDocument/hover',
      definition: 'textDocument/definition',
    } as const;
    return session.connection.sendRequest(methodByFeature[input.feature], {
      textDocument: { uri: remotePathToFileUri(normalizeRemotePath(input.remotePath)) },
      position: input.position,
    });
  }

  private configureConnection(session: LanguageServerSession): void {
    session.channel.stderr.on('data', (chunk: Buffer | string) => {
      session.stderr = `${session.stderr}${chunk.toString()}`.slice(-MAX_STDERR_LENGTH);
    });
    session.channel.on('error', (error: Error) => {
      if (!session.closing) {
        this.emitUnexpectedStop(session, getErrorMessage(error, 'Remote language server channel failed'));
      }
    });
    session.connection.onClose(() => {
      if (!session.closing) {
        this.emitUnexpectedStop(session, session.stderr.trim() || 'Remote language server stopped');
      }
    });
    session.connection.onError(([error]) => {
      if (!session.closing) {
        console.warn(`[language-server] ${error.message}`);
      }
    });
    session.connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
      const remotePath = fileUriToRemotePath(params.uri);
      if (!remotePath || !Array.isArray(params.diagnostics)) {
        return;
      }
      const event: LanguageServerDiagnosticsEvent = {
        sessionId: session.id,
        remotePath,
        diagnostics: params.diagnostics,
      };
      for (const listener of this.diagnosticsListeners) {
        listener(event);
      }
    });
    session.connection.onRequest('workspace/configuration', (params: { items?: unknown[] }) =>
      Array.isArray(params?.items) ? params.items.map(() => null) : [],
    );
    session.connection.onRequest('workspace/workspaceFolders', () => [
      { uri: remotePathToFileUri(session.workspacePath), name: path.posix.basename(session.workspacePath) || '/' },
    ]);
    session.connection.onRequest('client/registerCapability', () => null);
    session.connection.onRequest('client/unregisterCapability', () => null);
    session.connection.onRequest('window/workDoneProgress/create', () => null);
    session.connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'Apply edits in SSH Studio' }));
  }

  private requireSession(sessionId: string): LanguageServerSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.closing) {
      throw new Error('Language server session is not active');
    }
    return session;
  }

  private async stopSession(session: LanguageServerSession, emitState: boolean): Promise<void> {
    if (session.closing) {
      return;
    }
    session.closing = true;
    this.sessions.delete(session.id);
    await withTimeout(session.connection.sendRequest('shutdown').catch(() => undefined), SHUTDOWN_TIMEOUT_MS);
    await session.connection.sendNotification('exit').catch(() => undefined);
    session.connection.dispose();
    session.channel.destroy();
    if (emitState) {
      this.emitState({
        sessionId: session.id,
        workspacePath: session.workspacePath,
        language: session.language,
        status: 'stopped',
        message: 'Remote language server stopped',
      });
    }
  }

  private emitUnexpectedStop(session: LanguageServerSession, message: string): void {
    session.closing = true;
    this.sessions.delete(session.id);
    session.connection.dispose();
    session.channel.destroy();
    this.emitState({
      sessionId: session.id,
      workspacePath: session.workspacePath,
      language: session.language,
      status: 'error',
      message,
    });
  }

  private emitState(event: LanguageServerStateEvent): void {
    for (const listener of this.stateListeners) {
      listener(event);
    }
  }
}
