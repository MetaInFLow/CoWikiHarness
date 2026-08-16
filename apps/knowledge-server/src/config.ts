import { z } from "zod";

const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const openAIBaseUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}, "OPENAI_BASE_URL must use https unless it targets a loopback host");

const parsedConfigSchema = z.strictObject({
  databaseUrl: z.string().url(),
  tokenHmacSecret: z.string().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") >= 32,
    "OPENLIFEWIKI_TOKEN_HMAC_SECRET must be at least 32 bytes",
  ),
  model: z.string().min(1),
  publicUrl: z.string().url(),
  port: z.int().min(0).max(65_535),
  openAIApiKey: z.string().min(1),
  openAIBaseUrl: openAIBaseUrlSchema.optional(),
  modelReasoningEffort: reasoningEffortSchema.default("xhigh"),
  disableResponseStorage: z.literal(true),
  graphAllowedOrigins: z.array(z.string()),
});

export type ModelReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export class ServerConfig {
  readonly databaseUrl: string;
  readonly tokenHmacSecret!: string;
  readonly model: string;
  readonly publicUrl: string;
  readonly port: number;
  readonly openAIApiKey!: string;
  readonly openAIBaseUrl: string | undefined;
  readonly modelReasoningEffort: ModelReasoningEffort;
  readonly disableResponseStorage: true;
  readonly graphAllowedOrigins: readonly string[];

  constructor(value: z.infer<typeof parsedConfigSchema>) {
    this.databaseUrl = value.databaseUrl;
    this.model = value.model;
    this.publicUrl = value.publicUrl;
    this.port = value.port;
    this.openAIBaseUrl = value.openAIBaseUrl;
    this.modelReasoningEffort = value.modelReasoningEffort;
    this.disableResponseStorage = value.disableResponseStorage;
    this.graphAllowedOrigins = value.graphAllowedOrigins;
    Object.defineProperties(this, {
      tokenHmacSecret: { value: value.tokenHmacSecret, enumerable: false },
      openAIApiKey: { value: value.openAIApiKey, enumerable: false },
    });
  }
}

export function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const disableResponseStorage = env.OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE === undefined
    ? true
    : parseBoolean(env.OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE);
  return new ServerConfig(parsedConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    tokenHmacSecret: env.OPENLIFEWIKI_TOKEN_HMAC_SECRET,
    model: env.OPENLIFEWIKI_MODEL,
    publicUrl: env.OPENLIFEWIKI_PUBLIC_URL,
    port: parsePort(env.PORT ?? "8080"),
    openAIApiKey: env.OPENAI_API_KEY,
    openAIBaseUrl: env.OPENAI_BASE_URL,
    modelReasoningEffort: env.OPENLIFEWIKI_MODEL_REASONING_EFFORT,
    disableResponseStorage,
    graphAllowedOrigins: parseGraphAllowedOrigins(env.OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS),
  }));
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/u.test(value)) return Number.NaN;
  return Number(value);
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("OPENLIFEWIKI_DISABLE_RESPONSE_STORAGE must be true");
}

function parseGraphAllowedOrigins(value: string | undefined): string[] {
  if (value === undefined || value === "") return [];
  const origins = value.split(",").map((entry) => entry.trim());
  const seen = new Set<string>();
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS must contain exact origins");
    }
    const supportedProtocol = url.protocol === "https:"
      || (url.protocol === "http:" && isLoopbackHost(url.hostname));
    if (origin === "" || origin.includes("*") || url.origin !== origin
      || !supportedProtocol || seen.has(origin)) {
      throw new Error("OPENLIFEWIKI_GRAPH_ALLOWED_ORIGINS must contain unique HTTPS or loopback HTTP origins");
    }
    seen.add(origin);
  }
  return origins;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1"
    || hostname === "::1" || hostname === "[::1]";
}
