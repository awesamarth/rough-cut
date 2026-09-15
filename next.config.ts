import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
  agentRules: false,
};

export default async function config(phase: string) {
  // Normal local editing/builds need neither Cloudflare authentication nor a remote proxy.
  if (phase === PHASE_DEVELOPMENT_SERVER && process.env.ENABLE_CLOUD_DEV === "1") {
    await (await import("@opennextjs/cloudflare")).initOpenNextCloudflareForDev();
  }
  return nextConfig;
}
