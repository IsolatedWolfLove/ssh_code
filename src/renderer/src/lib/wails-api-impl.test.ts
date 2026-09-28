import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import api from './wails-api-impl';

afterEach(() => vi.unstubAllGlobals());
describe('Wails renderer bridge', () => {
  it('routes connection-scoped calls and decodes streamed frames', async () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const read = vi.fn(async () => ({ path: '/file', content: 'test' }));
    const disconnect = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      go: { app: { App: { Connect: async () => ({ connectionId: 'c1', filesystemState: 'ready' }), ReadFile: read, Disconnect: disconnect } } },
      runtime: { EventsOnMultiple: (name: string, callback: (value: unknown) => void) => { handlers.set(name, callback); return () => handlers.delete(name); } },
    });
    await api.connect({ host: 'localhost', port: 22, username: 'test', password: 'test' });
    expect(await api.readFile('/file')).toEqual({ path: '/file', content: 'test' });
    expect(read).toHaveBeenCalledWith('c1', '/file');
    const frame = vi.fn();
    const off = api.onVideoFrame(frame);
    handlers.get('video:frame')!({ streamId: 'v1', seq: 1, data: '/9j/2Q==' });
    expect(frame.mock.calls[0][0].data).toEqual(new Uint8Array([255, 216, 255, 217]));
    off();
    expect(handlers.has('video:frame')).toBe(false);
    await api.disconnect();
    expect(disconnect).toHaveBeenCalledWith('c1');
    await expect(api.readFile('/file')).rejects.toThrow('No active SSH connection');
  });

  it('sets the connection ID before connected-state subscribers run', async () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const metrics = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      go: { app: { App: { StartHostMetrics: metrics, Disconnect: async () => undefined } } },
      runtime: { EventsOnMultiple: (name: string, callback: (value: unknown) => void) => { handlers.set(name, callback); return () => handlers.delete(name); } },
    });
    api.onConnectionState(() => { void api.startHostMetrics('/workspace'); });
    handlers.get('connection:state')!({ state: 'connected', connectionId: 'c2' });
    expect(metrics).toHaveBeenCalledWith('c2', '/workspace', 5000);
    await api.disconnect();
  });

  it('has an exported Go method for every backend call', () => {
    const bridge = readFileSync(new URL('./wails-api-impl.ts', import.meta.url), 'utf8');
    const dir = new URL('../../../../server/app/', import.meta.url);
    // Relative to src/renderer/src/lib, the repository root is four levels up.
    const source = readdirSync(dir).filter((name: string) => name.endsWith('.go') && !name.endsWith('_test.go'))
      .map((name: string) => readFileSync(new URL(name, dir), 'utf8')).join('\n');
    const methods = [...bridge.matchAll(/(?:call|connected)(?:<[^>]+>)?\('([^']+)'/g)].map(m => m[1]);
    expect(methods.length).toBeGreaterThan(50);
    for (const method of methods) expect(source, method).toMatch(new RegExp(`func \\(a \\*App\\) ${method}\\(`));
  });
});
