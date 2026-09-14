/**
 * The model each project was last talked to with.
 *
 * A per-project preference rather than a per-account one: a Laravel project
 * and a scratch repo want different models, and picking the same one again
 * on every visit is the kind of small friction that adds up. Kept in
 * `localStorage` beside the sidebar and workspace preferences rather than on
 * the project row -- it is how this browser likes to work, not something the
 * project itself is true of, and a turn already records the model it used.
 *
 * Every access is guarded: `localStorage` throws outright in a private
 * window with site data blocked, and a preference is never worth an
 * exception in the composer.
 */

const PREFIX = "ucch:model:";

export function readLastModel(projectId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(PREFIX + projectId) || null;
  } catch {
    return null;
  }
}

export function rememberLastModel(projectId: string, model: string): void {
  try {
    // An empty id is what the picker holds before the catalogue loads;
    // storing it would come back as "no model" on the next visit.
    if (!model) return;
    globalThis.localStorage?.setItem(PREFIX + projectId, model);
  } catch {
    /* nothing to do: the choice simply is not remembered */
  }
}

/**
 * The provider each project was last talked to with, kept the same way and
 * for the same reason. A thread is bound to its provider on the server; this
 * is only which one the picker opens on before the first message.
 */
const PROVIDER_PREFIX = "ucch:provider:";

export function readLastProvider(projectId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(PROVIDER_PREFIX + projectId) || null;
  } catch {
    return null;
  }
}

export function rememberLastProvider(projectId: string, provider: string): void {
  try {
    if (!provider) return;
    globalThis.localStorage?.setItem(PROVIDER_PREFIX + projectId, provider);
  } catch {
    /* nothing to do: the choice simply is not remembered */
  }
}
