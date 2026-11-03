import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  setWorkspaceToken: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { handleOpenFile, isFileOpenTarget, openTarget } from '../openFile';

const rpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self', workspaceToken: 'claim' });
  rpc.mockResolvedValue({ id: '1', ok: true, result: { ok: true, path: '/tmp/x.md' } });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('isFileOpenTarget', () => {
  const none = () => false;
  it.each(['/tmp/x.md', './x.md', '../x', '~/x', 'C:\\x\\y.md', '\\\\wsl$\\Ubuntu\\x', 'file:///tmp/x.md'])(
    'treats %s as a file', (t) => expect(isFileOpenTarget(t, none)).toBe(true));
  it.each(['https://example.com', 'http://localhost:3000', 'localhost:3000', 'example.com'])(
    'keeps %s as a URL', (t) => expect(isFileOpenTarget(t, none)).toBe(false));
  it('treats a bare name of an existing file as a file', () => {
    expect(isFileOpenTarget('notes.md', () => true)).toBe(true);
  });
  it('tests the file without a :line[:col] suffix', () => {
    const exists = (p: string) => p === 'notes.md';
    expect(isFileOpenTarget('notes.md:12', exists)).toBe(true);
    expect(isFileOpenTarget('notes.md:12:3', exists)).toBe(true);
    expect(isFileOpenTarget('other.md:12', exists)).toBe(false);
  });
});

describe('openTarget', () => {
  it('skips flags and their values', () => {
    expect(openTarget(['--workspace', 'ws1', '/tmp/x.md'])).toBe('/tmp/x.md');
    expect(openTarget(['--line', '3', 'x.md', '--json'])).toBe('x.md');
    expect(openTarget(['--workspace', 'ws1'])).toBeUndefined();
  });
});

describe('handleOpenFile', () => {
  it('sends file.open with the caller workspace and pty', async () => {
    await handleOpenFile(['/tmp/x.md', '--line', '12'], false);
    expect(rpc).toHaveBeenCalledWith('file.open', {
      path: '/tmp/x.md', line: 12, workspaceId: 'ws-self', ptyId: 'pty-self',
    });
  });

  it('resolves a relative path against this shell cwd', async () => {
    await handleOpenFile(['rel/x.md'], false);
    const params = rpc.mock.calls[0][1] as { path: string };
    expect(params.path).toBe(path.resolve('rel/x.md'));
  });

  it('takes the positional as the path, not the --workspace value', async () => {
    await handleOpenFile(['--workspace', 'ws1', '/tmp/x.md'], false);
    expect(rpc).toHaveBeenCalledWith('file.open', {
      path: '/tmp/x.md', workspaceId: 'ws1', ptyId: 'pty-self',
    });
  });

  it('sends a :line suffix on to the app untouched', async () => {
    await handleOpenFile(['/tmp/x.md:12'], false);
    expect((rpc.mock.calls[0][1] as { path: string }).path).toBe('/tmp/x.md:12');
  });

  it('expands ~ to the home directory', async () => {
    await handleOpenFile(['~/notes/x.md'], false);
    expect((rpc.mock.calls[0][1] as { path: string }).path).toBe(path.join(homedir(), 'notes/x.md'));
  });

  it('refuses a missing path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit ${c}`); }) as never);
    await expect(handleOpenFile([], false)).rejects.toThrow('exit 1');
    expect(rpc).not.toHaveBeenCalled();
  });
});
