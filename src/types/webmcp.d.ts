type WebMCPTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  execute(input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown> | unknown;
};

interface Document {
  readonly modelContext?: {
    registerTool(tool: WebMCPTool, options?: { signal?: AbortSignal }): Promise<void>;
  };
}
