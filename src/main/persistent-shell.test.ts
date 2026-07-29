import { describe, expect, it } from 'vitest';

import {
  buildAttachCommand,
  buildKillSessionCommand,
  buildSessionName,
  buildSetSessionEnvCommand,
  normalizeSessionName,
  parseSessionList,
  parseSupportProbe,
} from './persistent-shell';

describe('persistent shell support probe', () => {
  it('prefers tmux and falls back to screen', () => {
    expect(parseSupportProbe('tmux\n')).toBe('tmux');
    expect(parseSupportProbe('screen\n')).toBe('screen');
  });

  it('reports none when no multiplexer is installed', () => {
    expect(parseSupportProbe('none\n')).toBe('none');
    expect(parseSupportProbe('')).toBe('none');
  });

  it('ignores shell noise printed before the answer', () => {
    expect(parseSupportProbe('Welcome to the lab node\ntmux\n')).toBe('tmux');
  });
});

describe('session naming', () => {
  it('derives a name from the workspace leaf', () => {
    expect(buildSessionName('/home/dev/train-runs', 1)).toBe('sshstudio-train-runs');
    expect(buildSessionName('/home/dev/train-runs', 3)).toBe('sshstudio-train-runs-3');
  });

  it('falls back to the bare prefix at the filesystem root', () => {
    expect(buildSessionName('/', 1)).toBe('sshstudio');
  });

  it('replaces characters that would break a tmux target', () => {
    expect(normalizeSessionName('runs/exp 1:final')).toBe('runs-exp-1-final');
    expect(normalizeSessionName('  ')).toBe('sshstudio');
    expect(normalizeSessionName('a'.repeat(80))).toHaveLength(60);
  });
});

// Must match the field separator used by buildListSessionsCommand.
const SEP = '\u0001';

describe('tmux session list parsing', () => {
  it('reads name, window count and attach state', () => {
    const stdout = [
      ['sshstudio-runs', '4', '1', '1767225600'].join(SEP),
      ['other', '1', '0', '1767222000'].join(SEP),
    ].join('\n');

    expect(parseSessionList('tmux', stdout)).toEqual([
      { name: 'sshstudio-runs', windows: 4, attached: true, createdAt: 1767225600 },
      { name: 'other', windows: 1, attached: false, createdAt: 1767222000 },
    ]);
  });

  it('returns an empty list when no tmux server is running', () => {
    expect(parseSessionList('tmux', '')).toEqual([]);
  });
});

describe('screen session list parsing', () => {
  it('reads pid-qualified names and attach state', () => {
    const stdout = [
      'There are screens on:',
      '\t3121.sshstudio-runs\t(01/02/2026 10:11:12 AM)\t(Detached)',
      '\t3200.sshstudio-eval\t(01/02/2026 11:00:00 AM)\t(Attached)',
      '2 Sockets in /run/screen/S-dev.',
    ].join('\n');

    expect(parseSessionList('screen', stdout)).toEqual([
      { name: '3121.sshstudio-runs', attached: false },
      { name: '3200.sshstudio-eval', attached: true },
    ]);
  });
});

describe('attach commands', () => {
  it('creates a tmux session only when it does not already exist', () => {
    const command = buildAttachCommand({
      kind: 'tmux',
      sessionName: 'sshstudio-runs',
      workspacePath: '/home/dev/train runs',
    });

    expect(command).toContain("tmux has-session -t 'sshstudio-runs'");
    expect(command).toContain("exec tmux -u attach-session -t 'sshstudio-runs'");
    expect(command).toContain("exec tmux -u new-session -s 'sshstudio-runs' -c '/home/dev/train runs'");
  });

  it('omits the working directory when no workspace is open', () => {
    expect(buildAttachCommand({ kind: 'tmux', sessionName: 'runs' })).not.toContain(' -c ');
  });

  it('uses screen reattach semantics as the fallback', () => {
    expect(buildAttachCommand({ kind: 'screen', sessionName: 'runs', workspacePath: '/data' })).toBe(
      "cd '/data'; exec screen -xRR -S 'runs'",
    );
  });

  it('refuses to build a command without a multiplexer', () => {
    expect(() => buildAttachCommand({ kind: 'none', sessionName: 'runs' })).toThrow(/multiplexer/);
  });

  it('quotes names so a crafted session name cannot inject a command', () => {
    const command = buildAttachCommand({ kind: 'tmux', sessionName: "runs'; rm -rf /tmp; echo '" });

    expect(command).not.toContain('rm -rf');
  });

  it('passes environment to both the attach and create branches', () => {
    const command = buildAttachCommand({
      kind: 'tmux',
      sessionName: 'runs',
      env: { DISPLAY: ':99' },
    });

    expect(command).toContain("exec DISPLAY=':99' tmux -u attach-session");
    expect(command).toContain("exec DISPLAY=':99' tmux -u new-session");
  });

  it('drops environment names that are not valid shell identifiers', () => {
    const command = buildAttachCommand({
      kind: 'tmux',
      sessionName: 'runs',
      env: { 'BAD;NAME': 'x' },
    });

    expect(command).not.toContain('BAD');
  });
});

describe('session environment updates', () => {
  it('uses tmux setenv so nothing is typed into a running job', () => {
    expect(buildSetSessionEnvCommand('tmux', 'runs', 'DISPLAY', ':99')).toBe(
      "tmux setenv -t 'runs' DISPLAY ':99'",
    );
  });

  it('has no screen equivalent and no way to inject a variable name', () => {
    expect(buildSetSessionEnvCommand('screen', 'runs', 'DISPLAY', ':99')).toBeNull();
    expect(buildSetSessionEnvCommand('tmux', 'runs', 'DISPLAY; rm -rf /', ':99')).toBeNull();
  });
});

describe('kill commands', () => {
  it('targets the named session per multiplexer', () => {
    expect(buildKillSessionCommand('tmux', 'runs')).toBe("tmux kill-session -t 'runs'");
    expect(buildKillSessionCommand('screen', '3121.runs')).toBe("screen -S '3121.runs' -X quit");
    expect(() => buildKillSessionCommand('none', 'runs')).toThrow(/multiplexer/);
  });
});
