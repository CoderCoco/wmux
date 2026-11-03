import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import type { BrowserAgentControl } from '../../browser-session/BrowserAgentControl';

type GetWindow = () => BrowserWindow | null;

/** What a teardown needs from main's per-tab agent control (Stop / Take over). */
export type AgentControlHolds = Pick<BrowserAgentControl, 'list' | 'refusal'>;

/**
 * The refusal for a teardown that would close a browser tab the user paused or
 * took over, or null. The renderer owns which tabs live where, so it is asked —
 * but only while some tab is held, which is rare; otherwise nothing is sent.
 * `pick` narrows the workspace's surfaces to the ones the teardown closes.
 * An answer that cannot be read refuses: a teardown is not undone.
 */
export async function heldBrowserSurfaceRefusal(
  getWindow: GetWindow,
  control: AgentControlHolds | undefined,
  method: string,
  workspaceIds: ReadonlyArray<string | undefined>,
  pick: (surface: { id: string; paneId?: string }) => boolean,
): Promise<Error | null> {
  if (!control) return null;
  const held = new Set(control.list().filter((s) => s.mode !== 'agent').map((s) => s.surfaceId));
  if (held.size === 0) return null;
  for (const workspaceId of workspaceIds) {
    const surfaces = await sendToRenderer(getWindow, 'surface.list', {
      ...(workspaceId && { workspaceId }),
      includeStashed: true,
    }).catch(() => null);
    if (!Array.isArray(surfaces)) {
      return new Error(
        `${method}: wmux could not check whether this closes a browser tab the user paused or took over, ` +
          'so nothing was closed. Retry once.',
      );
    }
    for (const s of surfaces as Array<{ id?: unknown; paneId?: unknown; surfaceType?: unknown }>) {
      if (s.surfaceType !== 'browser' || typeof s.id !== 'string' || !held.has(s.id)) continue;
      if (!pick({ id: s.id, ...(typeof s.paneId === 'string' && { paneId: s.paneId }) })) continue;
      const refusal = control.refusal(s.id, method);
      if (refusal) return refusal;
    }
  }
  return null;
}

export function registerSurfaceRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  // Stop / Take over on a browser tab: closing that tab is refused like any
  // other agent action on it. Absent means no tab is ever held.
  agentControl?: AgentControlHolds,
): void {
  /**
   * surface.list — returns surfaces of a workspace.
   * params: { workspaceId? } — omitted ⇒ active workspace.
   *
   * The renderer handler honors `workspaceId` (useRpcBridge.ts), but earlier
   * the main-side router dropped params entirely, silently scoping every
   * caller to the active workspace. Forward params unchanged so MCP callers
   * can target their own workspace explicitly (and enforcement layers above
   * can rely on the parameter being respected).
   */
  router.register('surface.list', (params) =>
    sendToRenderer(getWindow, 'surface.list', params),
  );

  /**
   * surface.new — creates a new surface in the active pane of a workspace.
   * params: { workspaceId?, shell?, cwd? } — omitted workspaceId ⇒ active ws.
   *
   * Earlier this dropped params entirely, so an explicit workspaceId/shell/cwd
   * was silently ignored and every surface opened in the on-screen workspace
   * (the #236 family of bugs). Forward them so a multi-agent caller can open a
   * terminal in ITS OWN workspace; the renderer fails closed on an unknown
   * explicit workspaceId.
   */
  router.register('surface.new', (params, ctx) => {
    let workspaceId = params['workspaceId'];
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      return Promise.reject(new Error('surface.new: "workspaceId" must be a string if provided'));
    }
    // BYOB P4: same commander confinement as pane.split — explicit mismatch
    // refused, omitted pinned to the commander's own workspace.
    if (ctx?.commanderWorkspace) {
      if (workspaceId !== undefined && workspaceId !== ctx.commanderWorkspace) {
        return Promise.reject(
          new Error('surface.new: workspace is outside the commander\'s workspace'),
        );
      }
      workspaceId = ctx.commanderWorkspace;
    }
    return sendToRenderer(getWindow, 'surface.new', {
      ...(workspaceId !== undefined && { workspaceId }),
      ...(typeof params['shell'] === 'string' && { shell: params['shell'] }),
      ...(typeof params['cwd'] === 'string' && { cwd: params['cwd'] }),
    });
  });

  /**
   * file.open — shows a file in a read-only editor/preview tab.
   * params: { path, line?, paneId?, workspaceId?, ptyId? } — the renderer picks
   * the pane (paneId > ptyId's pane > workspace's active pane) and resolves
   * the path (WSL-aware) with the same code a terminal click uses.
   */
  router.register('file.open', (params, ctx) => {
    const path = params['path'];
    if (typeof path !== 'string' || path.trim().length === 0) {
      return Promise.reject(new Error('file.open: missing required param "path"'));
    }
    const line = params['line'];
    if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
      return Promise.reject(new Error('file.open: "line" must be a positive integer if provided'));
    }
    for (const key of ['paneId', 'workspaceId', 'ptyId'] as const) {
      const v = params[key];
      if (v !== undefined && typeof v !== 'string') {
        return Promise.reject(new Error(`file.open: "${key}" must be a string if provided`));
      }
    }
    let workspaceId = params['workspaceId'] as string | undefined;
    // Same commander confinement as surface.new.
    if (ctx?.commanderWorkspace) {
      if (workspaceId !== undefined && workspaceId !== ctx.commanderWorkspace) {
        return Promise.reject(new Error("file.open: workspace is outside the commander's workspace"));
      }
      workspaceId = ctx.commanderWorkspace;
    }
    return sendToRenderer(getWindow, 'file.open', {
      path,
      ...(line !== undefined && { line }),
      ...(workspaceId !== undefined && { workspaceId }),
      ...(typeof params['paneId'] === 'string' && { paneId: params['paneId'] }),
      ...(typeof params['ptyId'] === 'string' && { ptyId: params['ptyId'] }),
    });
  });

  /**
   * surface.focus — focuses a specific surface
   * params: { id: string }
   */
  router.register('surface.focus', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('surface.focus: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'surface.focus', { id: params['id'] });
  });

  /**
   * surface.close — closes a specific surface
   * params: { id: string }
   */
  router.register('surface.close', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('surface.close: missing required param "id"'));
    }
    const userHold = agentControl?.refusal(params['id'], 'surface.close');
    if (userHold) return Promise.reject(userHold);
    return sendToRenderer(getWindow, 'surface.close', { id: params['id'] });
  });
}
