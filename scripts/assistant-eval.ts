// Live conversation evaluation (Goal 07). Opt-in: it makes paid OpenAI calls and is never run by
// tests or CI. Usage:
//   AI_EVAL_LIVE=1 OPENAI_API_KEY=... OPENAI_MODEL=... bun scripts/assistant-eval.ts
// Optional: AI_EVAL_MAX_USD (default 0.25) caps the run's own spend.
import { runEvaluation } from "../packages/core/src/assistant/eval";
import { createOpenAiProvider } from "../packages/core/src/assistant/openai";
import { DEFAULT_OPENAI_MODEL } from "../packages/core/src/config";

const env = process.env;
if (env.AI_EVAL_LIVE !== "1") {
  console.error("Refusing to make paid calls: set AI_EVAL_LIVE=1 to run the live evaluation.");
  process.exit(2);
}

if (!env.OPENAI_API_KEY) {
  console.error("Missing environment variable: OPENAI_API_KEY");
  process.exit(2);
}

const provider = createOpenAiProvider({
  apiKey: env.OPENAI_API_KEY,
  model: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
  pricing: { inputPerMillion: 0.4, outputPerMillion: 1.6 },
});

const report = await runEvaluation(provider, { maxCostUsd: Number(env.AI_EVAL_MAX_USD ?? "0.25") });
for (const result of report.results.filter((entry) => !entry.passed)) {
  console.log(`FAIL ${result.id} [${result.group}] "${result.message}": ${result.reason}`);
}
console.log(
  `passed ${report.passed}/${report.total} (tuning ${report.byGroup.tuning.passed}/${report.byGroup.tuning.total}, ` +
    `held-out ${report.byGroup.held_out.passed}/${report.byGroup.held_out.total}), spent about $${report.costUsd.toFixed(4)}`,
);
process.exit(report.passed === report.total ? 0 : 1);
