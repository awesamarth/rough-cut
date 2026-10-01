import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
  agentRules: false,
  turbopack: {
    rules: {
      "mediabunny-prores.mjs": { loaders: ["./scripts/prores-build-loader.cjs"], as: "*.js" },
    },
  },
  webpack(config) {
    config.module.rules.unshift({
      test: /[\\/]@mediabunny[\\/]prores[\\/]dist[\\/]bundles[\\/]mediabunny-prores\.mjs$/,
      enforce: "pre",
      use: [require.resolve("./scripts/prores-build-loader.cjs")],
    });
    return config;
  },
};

export default async function config(phase: string) {
  // Normal local editing/builds need neither Cloudflare authentication nor a remote proxy.
  if (phase === PHASE_DEVELOPMENT_SERVER && process.env.ENABLE_CLOUD_DEV === "1") {
    await (await import("@opennextjs/cloudflare")).initOpenNextCloudflareForDev();
  }
  return nextConfig;
}
