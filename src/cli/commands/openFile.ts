import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { sendRequest, setWorkspaceToken } from '../client';
import { printResult, ensureOk, parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';

/**
 * `wmux open <target>` is the browser opener for URLs and the file viewer for
 * paths. A target is a file when it is a file:// URL, an absolute/home/relative
 * path spelling (`/x`, `./x`, `../x`, `~/x`, `C:\x`, `\\host\x`), or names an
 * existing file; everything else (https://..., localhost:3000) stays a URL.
 */
export function isFileOpenTarget(target: string, exists: (p: string) => boolean = existsSync): boolean {
  if (/^file:\/\//i.test(target)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return false;
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~[\\/])/.test(target)) return true;
  // `notes.md:12` names notes.md at line 12: test the file without the suffix
  // (the full text first, in case the file really is called `a:12`).
  return exists(target) || exists(target.replace(/:\d+(?::\d+)?$/, ''));
}

/** Flags of `wmux open` that take a value, so their value is not the target. */
const OPEN_VALUE_FLAGS = new Set(['--line', '--workspace']);

/** The first positional argument of `wmux open`, skipping flags and their values. */
export function openTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (OPEN_VALUE_FLAGS.has(args[i])) { i++; continue; }
    if (!args[i].startsWith('--')) return args[i];
  }
  return undefined;
}

/** `~` and `~/x` mean this machine's home directory; the app does not expand them. */
function expandHome(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(homedir(), target.slice(2));
  return target;
}

/**
 * wmux open <path>[:line] [--line N] [--workspace <id>]
 *
 * Shows the file in a read-only editor/preview tab of the pane this runs in.
 * A relative path is resolved against this shell's cwd here, so it means the
 * same file the user would get from `cat`. Outside a wmux pane the active
 * workspace's pane is used.
 */
export async function handleOpenFile(args: string[], jsonMode: boolean): Promise<void> {
  const target = openTarget(args);
  if (!target) {
    console.error('Error: open requires <path> — e.g. `wmux open /tmp/notes.md`');
    process.exit(1);
  }

  let line: number | undefined;
  const lineFlag = parseFlag(args, '--line');
  if (lineFlag !== undefined) {
    line = Number(lineFlag);
    if (!Number.isInteger(line) || line < 1) {
      console.error('Error: --line must be a positive integer');
      process.exit(1);
    }
  }

  const self = await resolveSelfContext({
    sendRequest,
    env: process.env,
    ppid: process.ppid,
    getParentPid: getParentPidDefault,
    callerPid: process.pid,
  });
  if (self.workspaceToken) setWorkspaceToken(self.workspaceToken);

  // Only a plain relative path needs the CLI's cwd; the app resolves the rest
  // (including a WSL pane's POSIX paths) with the pane's own context.
  const expanded = expandHome(target);
  const isRelative = !/^(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)/i.test(expanded);
  const sendPath = isRelative ? path.resolve(expanded) : expanded;

  const params: Record<string, unknown> = { path: sendPath };
  if (line !== undefined) params.line = line;
  const workspaceId = parseFlag(args, '--workspace') ?? self.workspaceId;
  if (workspaceId) params.workspaceId = workspaceId;
  if (self.ptyId) params.ptyId = self.ptyId;

  const response = await sendRequest('file.open', params);
  if (jsonMode) {
    printResult(response);
  } else {
    ensureOk(response);
    const r = response.result as { path?: string } | undefined;
    console.log(`Opened in wmux: ${r?.path ?? sendPath}`);
  }
}
