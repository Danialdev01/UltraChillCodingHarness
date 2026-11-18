/** Delaying cleanup lets a quick return or React's development remount cancel it. */
const leaving = new Map<string, ReturnType<typeof setTimeout>>()

export function removeWhenLeft(projectHash: string, sessionHash: string | null): void {
  const key = sessionHash ?? projectHash
  keepSession(key)
  leaving.set(key, setTimeout(() => {
    leaving.delete(key)
    const path = sessionHash ? `sessions/${sessionHash}?ifEmpty=1` : "empty-session"
    void fetch(`/api/projects/${projectHash}/${path}`, {
      method: "DELETE", credentials: "include", keepalive: true,
    }).catch(() => {})
  }, 1500))
}

export function keepSession(key: string): void {
  clearTimeout(leaving.get(key))
  leaving.delete(key)
}
