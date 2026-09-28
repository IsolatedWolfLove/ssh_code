import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const go = process.env.GO || (existsSync('/usr/local/go/bin/go') ? '/usr/local/go/bin/go' : 'go');
const action = process.argv[2] || 'build';
const args = action === 'test'
  ? ['test', './...', ...process.argv.slice(3)]
  : ['run', 'github.com/wailsapp/wails/v2/cmd/wails@v2.16.0', action,
      ...(process.platform === 'linux' ? ['-tags', 'webkit2_41'] : []),
      ...process.argv.slice(3)];
const env = { ...process.env };
if (go.includes('/') || go.includes('\\')) env.PATH = `${dirname(go)}${delimiter}${env.PATH || ''}`;
const child = spawn(go, args, { cwd: join(root, 'server'), env, stdio: 'inherit' });
child.on('error', error => { console.error(`Unable to run Go: ${error.message}. Install Go 1.26.6+ or set GO to its executable.`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
