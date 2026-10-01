import { jsonError } from "@/lib/server";

// Source selection is local now. Keep the tombstone so stale clients cannot allocate R2 uploads.
export async function POST() {
  return jsonError("Cloud source uploads are retired. Reload and select a local video; existing cloud projects are unchanged.", 410);
}
