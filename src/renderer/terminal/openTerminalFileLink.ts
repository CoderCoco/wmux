/**
 * Click handler for a file path or `file:` link in a terminal pane.
 *
 * Resolves the text to a host path (WSL-aware, see shared/terminalFileLink),
 * then opens it as a read-only editor or preview tab in the pane's own
 * workspace. Directories, binaries, unreadable or oversized files, shadow
 * (remote) workspaces and the `os` setting all fall back to the OS opener.
 */

import { useStore } from '../stores';
import { getLeafPanes } from '../../shared/paneUtils';
import { isPreviewablePath } from '../../shared/filePreview';
import { isWslShell } from '../../shared/wslTarget';
import { isShadowWorkspaceId } from '../../shared/pcRail';
import { resolveTerminalFileLink } from '../../shared/terminalFileLink';
import { paneWslDistro } from './paneForegroundProbe';
import type { PathLocation } from './pathLinkProvider';

export interface OpenTerminalFileLinkDeps {
  /** OS opener (Electron shell.openPath, validated in main). */
  openWithOs: (filePath: string) => void;
  /** Raised when nothing could be opened at all (e.g. an unresolvable relative path). */
  onFailure: () => void;
  /**
   * The link came from an OSC 8 hyperlink, whose destination the program
   * controls and the user never saw. It may only open in the in-app viewer:
   * the OS opener is never reached (a hostile `file:` target must not hand the
   * OS a path to launch or a UNC share to authenticate against), so every
   * would-be fallback becomes `onFailure` instead.
   */
  viewerOnly?: boolean;
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

interface Located {
  workspaceId: string;
  paneId: string;
  shell: string;
  cwd: string;
}

function locatePty(ptyId: string | undefined): Located | null {
  if (!ptyId) return null;
  for (const ws of useStore.getState().workspaces) {
    for (const pane of getLeafPanes(ws.rootPane)) {
      const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
      if (surface) return { workspaceId: ws.id, paneId: pane.id, shell: surface.shell, cwd: surface.cwd };
    }
  }
  return null;
}

export async function openTerminalFileLink(
  raw: string,
  location: PathLocation | undefined,
  ptyId: string | undefined,
  deps: OpenTerminalFileLinkDeps,
): Promise<void> {
  const platform = window.electronAPI.platform;
  // Every OS-opener fallback below goes through here.
  const openWithOs = deps.viewerOnly ? () => deps.onFailure() : deps.openWithOs;
  const owner = locatePty(ptyId);
  const inWsl = owner !== null && isWslShell(owner.shell, platform);
  const distro = inWsl && ptyId ? await paneWslDistro(ptyId, window.electronAPI.pty) : undefined;
  const link = resolveTerminalFileLink({
    raw,
    hostPlatform: platform,
    shellKind: inWsl ? 'wsl' : 'native',
    distro,
    cwd: owner?.cwd || undefined,
  });

  if (!link) {
    // Nothing translated. An absolute path keeps the old behaviour (main
    // validates it); a relative one has no meaning to the OS opener.
    if (ABSOLUTE.test(raw)) openWithOs(raw.replace(/:\d+(?::\d+)?$/, ''));
    else deps.onFailure();
    return;
  }

  const state = useStore.getState();
  if (state.terminalOpenFileLinksIn === 'os' || !owner) {
    openWithOs(link.hostPath);
    return;
  }

  if (isPreviewablePath(link.hostPath)) {
    state.addPreviewSurface(owner.paneId, link.hostPath, { workspaceId: owner.workspaceId });
    return;
  }

  let content: string | null = null;
  try {
    content = await window.electronAPI.fs.readFile(link.hostPath);
  } catch {
    content = null;
  }
  // null: a directory, missing, blocked or over the 1 MB cap. NUL: binary.
  if (content === null || content.includes('\0')) {
    openWithOs(link.hostPath);
    return;
  }
  state.addEditorSurface(owner.paneId, link.hostPath, {
    workspaceId: owner.workspaceId,
    // The provider strips `:line:col` from the matched text and reports it
    // separately, so `location` carries it for plain path clicks.
    ...((link.line ?? location?.line) !== undefined && { line: (link.line ?? location?.line) as number }),
  });
}

export interface OpenFileInPaneInput {
  /** The path as the caller wrote it (POSIX path from a WSL agent, drive path, `file://`, relative). */
  raw: string;
  /** Explicit line; wins over a `:line` suffix in `raw`. */
  line?: number;
  workspaceId: string;
  paneId: string;
  /** The caller's terminal surface in that pane, when there is one: drives WSL translation and relative paths. */
  terminal?: { ptyId: string; shell: string; cwd: string };
}

export type OpenFileInPaneResult =
  | { ok: true; hostPath: string; surfaceType: 'editor' | 'preview' }
  | { ok: false; error: string };

/**
 * Open a file in an editor or preview tab of a given pane (the `file.open` RPC).
 * Unlike a terminal click this never falls back to the OS opener and ignores the
 * `terminalOpenFileLinksIn` setting: an agent asked for a tab, so a file the
 * viewer cannot read (directory, missing, binary, over 1 MB, fs-blocklisted) is
 * an error the caller can act on.
 */
export async function openFileInPane(input: OpenFileInPaneInput): Promise<OpenFileInPaneResult> {
  const platform = window.electronAPI.platform;
  const { terminal } = input;
  const inWsl = terminal !== undefined && isWslShell(terminal.shell, platform);
  const distro = inWsl && terminal ? await paneWslDistro(terminal.ptyId, window.electronAPI.pty) : undefined;
  const link = resolveTerminalFileLink({
    raw: input.raw,
    hostPlatform: platform,
    shellKind: inWsl ? 'wsl' : 'native',
    distro,
    cwd: terminal?.cwd || undefined,
  });
  if (!link) {
    return {
      ok: false,
      error: `file.open: cannot resolve "${input.raw}" to a path on this machine (use an absolute path, or a relative one from a terminal pane with a known cwd)`,
    };
  }
  if (isShadowWorkspaceId(input.workspaceId)) {
    return { ok: false, error: 'file.open: a local file cannot be opened in a remote computer\'s workspace' };
  }
  const state = useStore.getState();
  const line = input.line !== undefined && input.line > 0 ? input.line : link.line;

  if (isPreviewablePath(link.hostPath)) {
    state.addPreviewSurface(input.paneId, link.hostPath, { workspaceId: input.workspaceId });
    return { ok: true, hostPath: link.hostPath, surfaceType: 'preview' };
  }

  let content: string | null = null;
  try {
    content = await window.electronAPI.fs.readFile(link.hostPath);
  } catch {
    content = null;
  }
  if (content === null) {
    return {
      ok: false,
      error: `file.open: ${link.hostPath} cannot be opened in the viewer (missing, a directory, larger than 1 MB, or not readable by wmux)`,
    };
  }
  if (content.includes('\0')) {
    return { ok: false, error: `file.open: ${link.hostPath} looks like a binary file and cannot be shown in the viewer` };
  }
  state.addEditorSurface(input.paneId, link.hostPath, {
    workspaceId: input.workspaceId,
    ...(line !== undefined && { line }),
  });
  return { ok: true, hostPath: link.hostPath, surfaceType: 'editor' };
}
