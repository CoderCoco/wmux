import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeSetting = vi.hoisted(() => ({ value: 'tab' }));
const addEditorSurface = vi.fn();
const addPreviewSurface = vi.fn();
vi.mock('../../stores', () => ({
  useStore: {
    getState: () => ({
      addEditorSurface,
      addPreviewSurface,
      terminalOpenFileLinksIn: storeSetting.value,
      workspaces: [
        {
          id: 'w',
          rootPane: { id: 'p', type: 'leaf', surfaces: [{ ptyId: 'pty', shell: 'bash', cwd: '/home/u' }] },
        },
      ],
    }),
  },
}));

import { openFileInPane, openTerminalFileLink } from '../openTerminalFileLink';

const readFile = vi.fn();
const list = vi.fn();

function setPlatform(platform: string): void {
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { platform, fs: { readFile }, pty: { list } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([]);
  setPlatform('linux');
});

describe('openFileInPane', () => {
  it('opens a readable text file in an editor tab with the line', async () => {
    readFile.mockResolvedValue('# hi');
    const r = await openFileInPane({ raw: '/tmp/x.md', line: 4, workspaceId: 'w', paneId: 'p' });
    expect(r).toEqual({ ok: true, hostPath: '/tmp/x.md', surfaceType: 'editor' });
    expect(addEditorSurface).toHaveBeenCalledWith('p', '/tmp/x.md', { workspaceId: 'w', line: 4 });
  });

  it('uses a :line suffix when no explicit line is given', async () => {
    readFile.mockResolvedValue('x');
    await openFileInPane({ raw: '/tmp/x.ts:9', workspaceId: 'w', paneId: 'p' });
    expect(addEditorSurface).toHaveBeenCalledWith('p', '/tmp/x.ts', { workspaceId: 'w', line: 9 });
  });

  it('opens images in a preview tab without reading them', async () => {
    const r = await openFileInPane({ raw: '/tmp/a.png', workspaceId: 'w', paneId: 'p' });
    expect(r).toMatchObject({ ok: true, surfaceType: 'preview' });
    expect(addPreviewSurface).toHaveBeenCalledWith('p', '/tmp/a.png', { workspaceId: 'w' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('errors (no OS fallback) when the viewer cannot read the file', async () => {
    readFile.mockResolvedValue(null);
    const r = await openFileInPane({ raw: '/etc/shadow', workspaceId: 'w', paneId: 'p' });
    expect(r.ok).toBe(false);
    expect(addEditorSurface).not.toHaveBeenCalled();
  });

  it('errors on binary content', async () => {
    readFile.mockResolvedValue('a\0b');
    const r = await openFileInPane({ raw: '/tmp/bin', workspaceId: 'w', paneId: 'p' });
    expect(r.ok).toBe(false);
  });

  it('errors on an unresolvable relative path', async () => {
    const r = await openFileInPane({ raw: 'rel.md', workspaceId: 'w', paneId: 'p' });
    expect(r.ok).toBe(false);
  });

  it('resolves a relative path against the caller terminal cwd', async () => {
    readFile.mockResolvedValue('x');
    const r = await openFileInPane({
      raw: 'rel.md', workspaceId: 'w', paneId: 'p',
      terminal: { ptyId: 'pty', shell: 'bash', cwd: '/home/u' },
    });
    expect(r).toMatchObject({ ok: true, hostPath: '/home/u/rel.md' });
  });

  it('translates a WSL agent path to the \\\\wsl$ share on Windows', async () => {
    setPlatform('win32');
    list.mockResolvedValue([{ id: 'pty', wslTarget: { distribution: 'Ubuntu', user: 'u' } }]);
    readFile.mockResolvedValue('x');
    const r = await openFileInPane({
      raw: '/tmp/x.md', workspaceId: 'w', paneId: 'p',
      terminal: { ptyId: 'pty', shell: 'wsl.exe', cwd: '/home/u' },
    });
    expect(r).toMatchObject({ ok: true, hostPath: '\\\\wsl$\\Ubuntu\\tmp\\x.md' });
  });

  it('refuses a remote (shadow) workspace', async () => {
    const r = await openFileInPane({ raw: '/tmp/x.md', workspaceId: 'shadow:abc', paneId: 'p' });
    expect(r.ok).toBe(false);
  });
});

describe('openTerminalFileLink viewerOnly (OSC 8)', () => {
  const deps = () => ({ openWithOs: vi.fn(), onFailure: vi.fn(), viewerOnly: true });

  beforeEach(() => {
    storeSetting.value = 'tab';
  });

  it('never reaches the OS opener when the viewer cannot read the file', async () => {
    readFile.mockResolvedValue(null);
    const d = deps();
    await openTerminalFileLink('/tmp/x.sh', undefined, 'pty', d);
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledTimes(1);
  });

  it('never reaches the OS opener when the setting prefers the OS', async () => {
    storeSetting.value = 'os';
    const d = deps();
    await openTerminalFileLink('/tmp/x.md', undefined, 'pty', d);
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledTimes(1);
  });

  it('fails instead of opening a UNC target the resolver refuses', async () => {
    setPlatform('win32');
    const d = deps();
    await openTerminalFileLink('file://evil/share/x.md', undefined, 'pty', d);
    expect(d.openWithOs).not.toHaveBeenCalled();
    expect(d.onFailure).toHaveBeenCalledTimes(1);
  });

  it('still uses the OS opener for a plain-text click (no viewerOnly)', async () => {
    readFile.mockResolvedValue(null);
    const d = { openWithOs: vi.fn(), onFailure: vi.fn() };
    await openTerminalFileLink('/tmp/x.sh', undefined, 'pty', d);
    expect(d.openWithOs).toHaveBeenCalledWith('/tmp/x.sh');
  });
});
