import { Container } from "@cloudflare/containers";

interface Env {
  MEDIA_CONTAINER: DurableObjectNamespace<MediaContainer>;
  MEDIA_WORKER_TOKEN: string;
}

export class MediaContainer extends Container {
  defaultPort = 8788;
  sleepAfter = "10m";
  envVars = {
    PORT: "8788",
    DATA_DIR: "/tmp/jobs",
    APP_ORIGIN: "https://rough-cut.samarthsaxena1672003.workers.dev",
  };
}

export default {
  async fetch(request: Request, env: Env) {
    if (!env.MEDIA_WORKER_TOKEN || request.headers.get("authorization") !== `Bearer ${env.MEDIA_WORKER_TOKEN}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    // ponytail: one named instance keeps ephemeral job state simple; shard by project when concurrent exports justify it.
    return env.MEDIA_CONTAINER.getByName("main").fetch(request);
  },
} satisfies ExportedHandler<Env>;
