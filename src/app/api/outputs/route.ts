import { serveCloudOutput } from "@/lib/cloud-outputs";
import { cloudflare } from "@/lib/server";

export const dynamic = "force-dynamic";
async function output(request: Request) {
  try { return await serveCloudOutput(request, cloudflare()); }
  catch { return Response.json({ error: "Cloud storage could not complete the request. You can export locally instead." }, { status: 503 }); }
}
export const POST = output;
export const PUT = output;
export const GET = output;
export const DELETE = output;
