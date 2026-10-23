import type { Intent } from "./intent";

// Only whole, unambiguous messages qualify. Anything with additional instructions goes to AI.
export function routineIntent(message: string): Intent | null {
  const text = message
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .trim();
  if (
    /^(?:(?:hey|hi)[ ,]+epi[ ,]+)?(?:(?:please|epi)[ ,]+)?(?:(?:can|could|would) you )?(?:give|send|show) me (?:the |your |our )?(?:website|dashboard|site)(?: link| url)?(?: please)?$/.test(
      text,
    ) ||
    /^(?:what(?:'s| is)|where(?:'s| is)) (?:the |your |our )?(?:website|dashboard|site)(?: link| url)?$/.test(
      text,
    )
  ) {
    return { kind: "website_link" };
  }
  if (/^(?:yes|yep|yeah|confirm|go ahead|do it|save (?:them|these|all))$/.test(text)) {
    return { kind: "confirm" };
  }
  if (/^(?:no|nope|cancel|never mind|nevermind|don't save|do not save)$/.test(text)) {
    return { kind: "decline" };
  }
  if (/^(?:hi|hello|hey)(?:[ ,]+epi)?$/.test(text)) {
    return { kind: "respond", text: "Hi! What would you like help with?" };
  }
  if (/^(?:thanks|thank you)(?:[ ,]+epi)?$/.test(text)) {
    return { kind: "respond", text: "You're welcome!" };
  }
  return null;
}
