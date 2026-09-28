import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Preserve full logs, and expose failed test details as Actions annotations.
const result = spawnSync(process.env.GO || 'go', ['test', '-json', './...', '-timeout=180s'], {
  cwd: fileURLToPath(new URL('../server', import.meta.url)),
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const output = new Map();
const escape = text => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
for (const line of (result.stdout || '').split('\n')) {
  if (!line) continue;
  let event;
  try { event = JSON.parse(line); } catch { console.log(line); continue; }
  const key = `${event.Package} ${event.Test || ''}`;
  if (event.Output) {
    process.stdout.write(event.Output);
    output.set(key, (output.get(key) || '') + event.Output);
  }
  if (event.Action === 'fail' && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Go test failure::${escape((output.get(key) || key).slice(-16000))}`);
  }
}
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);
if (result.status !== 0 && process.env.GITHUB_ACTIONS && result.stderr) {
  console.log(`::error title=Go compiler output::${escape(result.stderr.slice(-16000))}`);
}
process.exitCode = result.status ?? 1;
