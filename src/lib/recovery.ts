/** Session storage is cloned by duplicated tabs. A live Web Lock prevents shared journal ownership. */
export async function claimRecoveryKey(projectId: string, signal: AbortSignal) {
  if (!navigator.locks) throw new Error("Crash-safe editing requires a browser with Web Locks support");
  const sessionKey = `rough-cut.tab:${projectId}`;
  let identity = sessionStorage.getItem(sessionKey) || sessionStorage.getItem("rough-cut.tab") || crypto.randomUUID();
  while (true) {
    signal.throwIfAborted();
    const key = `rough-cut.recovery:${projectId}:${identity}`;
    const acquired = await new Promise<boolean>((resolve, reject) => {
      void navigator.locks.request(key, { ifAvailable: true }, (lock) => {
        if (!lock || signal.aborted) { resolve(false); return; }
        return new Promise<void>((release) => {
          signal.addEventListener("abort", () => release(), { once: true });
          resolve(true);
        });
      }).catch(reject);
    });
    signal.throwIfAborted();
    if (acquired) { sessionStorage.setItem(sessionKey, identity); return key; }
    identity = crypto.randomUUID();
  }
}
