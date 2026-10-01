import { cloudOutputWriter } from "./cloud-output-writer";

export type CloudOutputSession = { id: string; filename: string; maxBytes: number; expiresAt: number };
const endpoint = (session: CloudOutputSession) => `/api/outputs?id=${encodeURIComponent(session.id)}`;
export const cloudOutputUrl = endpoint;
async function checked(response: Response) {
  if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error || `Cloud output failed (${response.status})`);
  return response;
}
export async function requestCloudOutput(filename: string, maxBytes: number, signal: AbortSignal): Promise<CloudOutputSession> {
  return (await checked(await fetch("/api/outputs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename, maxBytes }), signal }))).json();
}
export async function cancelCloudOutput(session: CloudOutputSession) {
  await checked(await fetch(endpoint(session), { method: "DELETE", signal: AbortSignal.timeout(10_000) }));
}
export function cloudOutputDestination(session: CloudOutputSession, signal: AbortSignal) {
  const headers = { "content-type": "application/octet-stream" };
  return { async createWritable() {
    signal.throwIfAborted();
    return cloudOutputWriter(session.maxBytes,
      async (part, bytes) => { await checked(await fetch(`${endpoint(session)}&part=${part}`, { method: "PUT", headers, body: bytes as Uint8Array<ArrayBuffer>, signal })); },
      async (bytes) => { signal.throwIfAborted(); await checked(await fetch(endpoint(session), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ bytes }), signal })); },
      () => cancelCloudOutput(session),
    );
  } };
}
