import { z } from "zod";

export class ConfigError extends Error {
  readonly service: string;
  readonly issues: readonly string[];

  constructor(service: string, issues: readonly string[]) {
    super(
      [
        `Invalid ${service} configuration:`,
        ...issues.map((issue) => `  - ${issue}`),
        "Copy .env.example to .env and set the values listed above (see docs/local-development.md).",
      ].join("\n"),
    );
    this.name = "ConfigError";
    this.service = service;
    this.issues = issues;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface SharedConfig {
  databaseUrl: string;
  timezone: string;
}

export type WebConfig = SharedConfig;

export interface WorkerConfig extends SharedConfig {
  healthPort: number;
}

const DEFAULT_TIMEZONE = "America/Chicago";
const DEFAULT_WORKER_HEALTH_PORT = 3001;

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isMysqlUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "mysql:" &&
      url.hostname !== "" &&
      url.username !== "" &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

const required = (hint: string) =>
  z
    .string({ error: `is required: ${hint}` })
    .trim()
    .min(1, `is required: ${hint}`);

const sharedSchema = z.object({
  DATABASE_URL: required(
    "set the dedicated Epiphany MySQL URL, e.g. mysql://user:<password>@host:3306/epiphany",
  ).refine(
    isMysqlUrl,
    "must be a mysql:// URL with a host, user, and database name (value hidden)",
  ),
  APP_TIMEZONE: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_TIMEZONE)
    .refine(isValidTimeZone, "must be an IANA timezone such as America/Chicago"),
});

const workerSchema = sharedSchema.extend({
  WORKER_HEALTH_PORT: z.coerce
    .number({ error: "must be a whole number between 1 and 65535" })
    .int("must be a whole number between 1 and 65535")
    .min(1, "must be a whole number between 1 and 65535")
    .max(65535, "must be a whole number between 1 and 65535")
    .default(DEFAULT_WORKER_HEALTH_PORT),
});

function parse<T extends z.ZodType>(service: string, schema: T, env: Env): z.output<T> {
  const input = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      service,
      result.error.issues.map((issue) => {
        const name = issue.path.join(".") || "environment";
        return `${name} ${issue.message}`;
      }),
    );
  }
  return result.data;
}

export function loadWebConfig(env: Env): WebConfig {
  const parsed = parse("web", sharedSchema, env);
  return { databaseUrl: parsed.DATABASE_URL, timezone: parsed.APP_TIMEZONE };
}

export function loadDatabaseToolingConfig(env: Env): Pick<SharedConfig, "databaseUrl"> {
  const parsed = parse("database tooling", sharedSchema.pick({ DATABASE_URL: true }), env);
  return { databaseUrl: parsed.DATABASE_URL };
}

export interface AuthConfig {
  // Null only in development-bypass mode, where Discord sign-in is optional.
  discordClientId: string | null;
  discordClientSecret: string | null;
  ownerDiscordUserId: string | null;
  appUrl: string;
  secureCookies: boolean;
  timezone: string;
  // ENV_BYPASS=dev: sign in as the owner without Discord. Development on localhost only.
  devBypass: boolean;
}

const authSchema = sharedSchema.pick({ APP_TIMEZONE: true }).extend({
  DISCORD_CLIENT_ID: required("the Discord application's client ID (Developer Portal > OAuth2)"),
  DISCORD_CLIENT_SECRET: required(
    "the Discord application's client secret (Developer Portal > OAuth2)",
  ),
  OWNER_DISCORD_USER_ID: required(
    "your Discord user ID (Discord > Settings > Advanced > Developer Mode, then right-click your name > Copy User ID)",
  ).regex(/^\d{15,25}$/, "must be a numeric Discord user ID (value hidden)"),
  APP_URL: required("the dashboard's public URL, e.g. http://localhost:3000").refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL (value hidden)"),
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

// ENV_BYPASS=dev lets the owner sign in without Discord. It is refused (never silently ignored)
// outside development on localhost, so it cannot be left on in a deployed build.
function loadDevBypass(env: Env): AuthConfig {
  const issues: string[] = [];
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    issues.push(
      "ENV_BYPASS=dev is only allowed in development (bun run dev). Unset ENV_BYPASS for production builds.",
    );
  }

  let appUrl = new URL("http://localhost:3000");
  const rawUrl = env.APP_URL?.trim();
  if (rawUrl) {
    try {
      appUrl = new URL(rawUrl);
    } catch {
      issues.push("APP_URL must be an http(s) URL (value hidden)");
    }
  }
  if (appUrl.protocol !== "http:" && appUrl.protocol !== "https:") {
    issues.push("APP_URL must be an http(s) URL (value hidden)");
  } else if (!isLoopbackHost(appUrl.hostname)) {
    issues.push("ENV_BYPASS=dev requires APP_URL to be localhost, 127.0.0.1, or [::1]");
  }

  const ownerId = env.OWNER_DISCORD_USER_ID?.trim() || null;
  if (ownerId && !/^\d{15,25}$/.test(ownerId)) {
    issues.push("OWNER_DISCORD_USER_ID must be a numeric Discord user ID (value hidden)");
  }
  const timezone = env.APP_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone))
    issues.push("APP_TIMEZONE must be an IANA timezone such as America/Chicago");

  if (issues.length > 0) throw new ConfigError("dashboard sign-in", issues);
  return {
    discordClientId: env.DISCORD_CLIENT_ID?.trim() || null,
    discordClientSecret: env.DISCORD_CLIENT_SECRET?.trim() || null,
    ownerDiscordUserId: ownerId,
    appUrl: appUrl.origin,
    secureCookies: false,
    timezone,
    devBypass: true,
  };
}

// Sign-in settings. Kept separate from loadWebConfig so the dashboard still starts, and shows an
// actionable message on the sign-in page, when they have not been set up yet.
export function loadAuthConfig(env: Env): AuthConfig {
  const bypass = env.ENV_BYPASS?.trim() ?? "";
  if (bypass !== "" && bypass !== "dev") {
    throw new ConfigError("dashboard sign-in", [
      'ENV_BYPASS must be "dev" or unset (value hidden)',
    ]);
  }
  if (bypass === "dev") return loadDevBypass(env);

  const parsed = parse("dashboard sign-in", authSchema, env);
  const appUrl = new URL(parsed.APP_URL);
  return {
    discordClientId: parsed.DISCORD_CLIENT_ID,
    discordClientSecret: parsed.DISCORD_CLIENT_SECRET,
    ownerDiscordUserId: parsed.OWNER_DISCORD_USER_ID,
    appUrl: appUrl.origin,
    secureCookies: appUrl.protocol === "https:",
    timezone: parsed.APP_TIMEZONE,
    devBypass: false,
  };
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  const parsed = parse("worker", workerSchema, env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    timezone: parsed.APP_TIMEZONE,
    healthPort: parsed.WORKER_HEALTH_PORT,
  };
}

// The default model and its list price (USD per million tokens). Same model DiscordNPC uses;
// confirm the prices against OpenAI's pricing page, or override them in .env.
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_PRICES = { input: 0.4, output: 1.6 };

export interface AiConfig {
  // False until OPENAI_API_KEY is set; the dashboard shows setup help instead of failing.
  enabled: boolean;
  apiKey: string | null;
  model: string;
  baseUrl: string | null;
  pricing: { inputPerMillion: number; outputPerMillion: number };
  monthlyBudgetUsd: number;
  warnPercent: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timezone: string;
}

const positive = (hint: string) =>
  z.coerce.number({ error: `must be a number ${hint}` }).positive(`must be a number ${hint}`);

const aiSchema = z.object({
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_MODEL: z.string().trim().min(1).default(DEFAULT_OPENAI_MODEL),
  OPENAI_BASE_URL: z
    .string()
    .trim()
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    }, "must be an http(s) URL (value hidden)")
    .optional(),
  OPENAI_PRICE_INPUT_PER_MTOK: z.coerce
    .number({ error: "must be a non-negative number (USD per million tokens)" })
    .min(0, "must be a non-negative number (USD per million tokens)")
    .optional(),
  OPENAI_PRICE_OUTPUT_PER_MTOK: z.coerce
    .number({ error: "must be a non-negative number (USD per million tokens)" })
    .min(0, "must be a non-negative number (USD per million tokens)")
    .optional(),
  AI_MONTHLY_BUDGET_USD: positive("above zero").default(10),
  AI_BUDGET_WARN_PERCENT: z.coerce
    .number({ error: "must be a number between 1 and 100" })
    .min(1, "must be a number between 1 and 100")
    .max(100, "must be a number between 1 and 100")
    .default(80),
  AI_MAX_INPUT_TOKENS: positive("above zero").pipe(z.number().int()).default(8000),
  AI_MAX_OUTPUT_TOKENS: positive("above zero").pipe(z.number().int()).default(1000),
  APP_TIMEZONE: sharedSchema.shape.APP_TIMEZONE,
});

// Reads the text-AI settings. Only OPENAI_API_KEY is needed; everything else has a default.
// A non-default model must come with its prices so the monthly budget is metered correctly.
export function loadAiConfig(env: Env): AiConfig {
  // A key that is only whitespace counts as not set.
  const parsed = parse("assistant", aiSchema, {
    ...env,
    OPENAI_API_KEY: env.OPENAI_API_KEY?.trim(),
  });
  const customModel = parsed.OPENAI_MODEL !== DEFAULT_OPENAI_MODEL;
  const input = parsed.OPENAI_PRICE_INPUT_PER_MTOK;
  const output = parsed.OPENAI_PRICE_OUTPUT_PER_MTOK;
  if (customModel && (input === undefined || output === undefined)) {
    throw new ConfigError("assistant", [
      "OPENAI_PRICE_INPUT_PER_MTOK and OPENAI_PRICE_OUTPUT_PER_MTOK are required when OPENAI_MODEL is not the default, so spending can be metered",
    ]);
  }
  return {
    enabled: parsed.OPENAI_API_KEY !== undefined,
    apiKey: parsed.OPENAI_API_KEY ?? null,
    model: parsed.OPENAI_MODEL,
    baseUrl: parsed.OPENAI_BASE_URL ?? null,
    pricing: {
      inputPerMillion: input ?? DEFAULT_PRICES.input,
      outputPerMillion: output ?? DEFAULT_PRICES.output,
    },
    monthlyBudgetUsd: parsed.AI_MONTHLY_BUDGET_USD,
    warnPercent: parsed.AI_BUDGET_WARN_PERCENT,
    maxInputTokens: parsed.AI_MAX_INPUT_TOKENS,
    maxOutputTokens: parsed.AI_MAX_OUTPUT_TOKENS,
    timezone: parsed.APP_TIMEZONE,
  };
}
