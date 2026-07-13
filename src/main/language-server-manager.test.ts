import { Duplex, PassThrough } from 'node:stream';

import type { Client as SshClient, ClientChannel } from 'ssh2';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node';
import { describe, expect, it } from 'vitest';

import { RemoteLanguageServerManager, fileUriToRemotePath, remotePathToFileUri } from './language-server-manager';

function createLanguageServerHarness(): { client: SshClient; server: MessageConnection } {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const channel = Duplex.from({ readable: serverToClient, writable: clientToServer }) as ClientChannel;
  Object.defineProperty(channel, 'stderr', { value: new PassThrough() });
  const server = createMessageConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient),
  );
  server.onRequest('initialize', () => ({ capabilities: { textDocumentSync: 2 } }));
  server.onRequest('shutdown', () => null);
  server.listen();

  const client = {
    exec: (_command: string, callback: (error: Error | undefined, stream: ClientChannel) => void) => {
      callback(undefined, channel);
    },
  } as unknown as SshClient;
  return { client, server };
}

describe('remote language server URI mapping', () => {
  it('round-trips absolute remote paths', () => {
    const remotePath = '/home/dev/my project/src/app.ts';
    const uri = remotePathToFileUri(remotePath);

    expect(uri).toBe('file:///home/dev/my%20project/src/app.ts');
    expect(fileUriToRemotePath(uri)).toBe(remotePath);
  });

  it('normalizes remote path segments', () => {
    expect(remotePathToFileUri('/home/dev/project/src/../app.ts')).toBe('file:///home/dev/project/app.ts');
  });

  it('rejects relative paths and non-file URIs', () => {
    expect(() => remotePathToFileUri('src/app.ts')).toThrow('absolute');
    expect(fileUriToRemotePath('ssh://session/home/dev/app.ts')).toBeNull();
    expect(fileUriToRemotePath('file://server/home/dev/app.ts')).toBeNull();
  });
});

describe('remote language server lifecycle', () => {
  it('initializes, synchronizes a document, and forwards feature requests', async () => {
    const { client, server } = createLanguageServerHarness();
    const manager = new RemoteLanguageServerManager();
    const opened = new Promise<Record<string, unknown>>((resolve) => {
      server.onNotification('textDocument/didOpen', resolve);
    });
    server.onRequest('textDocument/completion', () => [{ label: 'answer', kind: 6 }]);

    const session = await manager.start(client, { workspacePath: '/workspace', language: 'typescript' });
    await manager.openDocument({
      sessionId: session.sessionId,
      remotePath: '/workspace/app.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const value = ans',
    });

    expect(await opened).toMatchObject({
      textDocument: {
        uri: 'file:///workspace/app.ts',
        languageId: 'typescript',
        version: 1,
      },
    });
    await expect(
      manager.requestFeature({
        sessionId: session.sessionId,
        remotePath: '/workspace/app.ts',
        feature: 'completion',
        position: { line: 0, character: 17 },
      }),
    ).resolves.toEqual([{ label: 'answer', kind: 6 }]);

    await manager.stop(session.sessionId);
    server.dispose();
  });
});
