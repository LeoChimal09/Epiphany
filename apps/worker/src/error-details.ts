const SECRET_ASSIGNMENT =
  /\b(password|passwd|token|secret|api[_-]?key|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;

function safeMessage(message: string): string {
  return message
    .replace(URL, "[redacted URL]")
    .replace(SECRET_ASSIGNMENT, "$1$2[redacted]")
    .replace(/\s+(?:sql|query)\s*[:=].*$/i, " [query omitted]")
    .slice(0, 240);
}

export function errorDetails(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) {
    return { errorName: "NonErrorThrown" };
  }
  const code = "code" in error ? error.code : undefined;
  const message = safeMessage(error.message);
  return {
    errorName: error.name.slice(0, 80),
    ...(typeof code === "string" || typeof code === "number"
      ? { errorCode: String(code).slice(0, 80) }
      : {}),
    ...(message ? { errorMessage: message } : {}),
  };
}
