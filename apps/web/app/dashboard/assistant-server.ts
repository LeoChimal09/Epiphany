import { ConfigError, loadAiConfig, type AiConfig } from "@epiphany/core";
import {
  createAssistant,
  createBudget,
  createDbUsageStore,
  createOpenAiProvider,
  type AssistantReply,
  type ConversationState,
} from "@epiphany/core/assistant";
import { createServices, issueOwnerPrincipal } from "@epiphany/core/services";
import { getAuthDeps } from "../../lib/auth/deps";

export type AssistantAvailability = "ready" | "needs_key" | "misconfigured";

function readConfig(): AiConfig | { error: string } {
  try {
    return loadAiConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    return { error: "misconfigured" };
  }
}

export function assistantAvailability(): AssistantAvailability {
  const config = readConfig();
  if ("error" in config) return "misconfigured";
  return config.enabled ? "ready" : "needs_key";
}

export interface AssistantTurnResult {
  reply: AssistantReply;
  state: ConversationState;
  budgetNote: string | null;
}

export async function askAssistant(
  ownerId: string,
  message: string,
  state: ConversationState,
): Promise<AssistantTurnResult | null> {
  const config = readConfig();
  if ("error" in config || !config.enabled || !config.apiKey) return null;
  const deps = getAuthDeps();
  if (!deps) return null;

  const principal = await issueOwnerPrincipal(deps.db, ownerId, {
    source: "dashboard",
    audience: "private",
    initiator: "assistant",
  });
  const budget = createBudget(
    {
      monthlyLimitUsd: config.monthlyBudgetUsd,
      warnPercent: config.warnPercent,
      timezone: config.timezone,
    },
    createDbUsageStore(deps.db, ownerId),
    deps.clock,
  );
  const assistant = createAssistant({
    appUrl: deps.config.appUrl,
    services: createServices(deps.db, { clock: deps.clock }),
    provider: createOpenAiProvider({
      apiKey: config.apiKey,
      model: config.model,
      pricing: config.pricing,
      maxInputTokens: config.maxInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    }),
    budget,
    timezone: config.timezone,
    clock: deps.clock,
  });

  const result = await assistant.handle(principal, message, state, {
    sourceRef: "dashboard:ask-epi",
  });
  const status = await budget.check();
  return {
    ...result,
    budgetNote: status.warn
      ? `${Math.min(100, Math.floor(status.percent))}% of this month's AI budget is used.`
      : null,
  };
}
