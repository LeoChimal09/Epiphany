// The owner can say a message is just conversation. That is honored in code, not left to the model:
// when a message asks not to be saved, no task or note is created from it, whatever the model said.
const NOT_TO_SAVE = [
  /\b(?:don'?t|do not|dont)\s+(?:(?:need|have|want|bother)\s+to\s+)?(?:save|store|add|record|log|track)\b/i,
  /\b(?:don'?t|do not|dont)\s+make\s+(?:it|that|this)\s+(?:a|an)\s+(?:task|note|reminder|idea)\b/i,
  /\bno need to\s+(?:save|store|add|record|log|track|keep)\b/i,
  /\bwithout\s+(?:saving|storing|recording|logging|tracking)\b/i,
  /\bjust\s+(?:chatting|venting|talking|thinking out loud|thinking aloud|musing)\b/i,
  /\boff the record\b/i,
  /\bnot\s+(?:a|an)\s+(?:task|assignment|note)\b/i,
];

export function asksNotToSave(text: string): boolean {
  return NOT_TO_SAVE.some((pattern) => pattern.test(text));
}
