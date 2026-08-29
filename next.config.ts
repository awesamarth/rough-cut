import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
};

export default nextConfig;

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
