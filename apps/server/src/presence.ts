import type { PresenceViewer } from "@ucch/protocol";

/**
 * Who has which project open, and where in it.
 *
 * Keyed by socket rather than by person: one person in two windows is two
 * viewers, which is exactly what the editor needs to warn about. A socket
 * that closes takes its entries with it, so nothing here outlives the tab.
 */
export class PresenceStore {
  /** projectId -> connection id -> viewer */
  #projects = new Map<string, Map<string, PresenceViewer>>();

  /** Records or clears one socket's place; returns the project's viewers if they changed. */
  set(projectId: string, connectionId: string, viewer: PresenceViewer | null): PresenceViewer[] | null {
    let viewers = this.#projects.get(projectId);
    const before = viewers?.get(connectionId);
    if (!viewer) {
      if (!before) return null;
      viewers!.delete(connectionId);
      if (viewers!.size === 0) this.#projects.delete(projectId);
      return this.list(projectId);
    }
    if (
      before &&
      before.location === viewer.location &&
      before.editing === viewer.editing &&
      before.userId === viewer.userId
    ) {
      return null;
    }
    if (!viewers) {
      viewers = new Map();
      this.#projects.set(projectId, viewers);
    }
    viewers.set(connectionId, viewer);
    return this.list(projectId);
  }

  /** Drops a closed socket everywhere; returns each project whose viewers changed. */
  drop(connectionId: string): Array<{ projectId: string; viewers: PresenceViewer[] }> {
    const changed: Array<{ projectId: string; viewers: PresenceViewer[] }> = [];
    for (const [projectId, viewers] of this.#projects) {
      if (!viewers.delete(connectionId)) continue;
      if (viewers.size === 0) this.#projects.delete(projectId);
      changed.push({ projectId, viewers: this.list(projectId) });
    }
    return changed;
  }

  list(projectId: string): PresenceViewer[] {
    return [...(this.#projects.get(projectId)?.values() ?? [])];
  }
}
