/**
 * Whether a project is trusted for OMP (solution §0.3, OM7.6): only then
 * do its OMP turns and bridge calls run the repository's own language
 * servers and debugger config. Any member reads it; a workspace admin
 * changes it.
 */
export interface OmpTrustState {
  trusted: boolean;
  /** The caller is a workspace admin, who alone may change it. */
  canChange: boolean;
}

async function call(hash: string, fallback: string, init?: RequestInit): Promise<OmpTrustState> {
  const response = await fetch(`/api/projects/${hash}/omp-trust`, { credentials: "include", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? fallback);
  }
  return (await response.json()) as OmpTrustState;
}

export const fetchOmpTrust = (hash: string) => call(hash, "Could not load whether the project is trusted.");

export const setOmpTrust = (hash: string, trusted: boolean) =>
  call(hash, "Could not change whether the project is trusted.", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trusted }),
  });
