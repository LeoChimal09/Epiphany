import { execFileSync } from "node:child_process";

export interface Finding {
  file: string;
  line?: number;
  reason: string;
}

const MAX_SCAN_BYTES = 1_000_000;

const SKIPPED_PATHS = [/^bun\.lock$/, /^node_modules\//, /(^|\/)\.next\//];

const BLOCKED_FILE_NAMES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)\.env(\.[^/]*)?$/, reason: "environment file" },
  { pattern: /\.(pem|key|p12|pfx)$/i, reason: "key or certificate file" },
  { pattern: /(^|\/)credentials[^/]*\.json$/i, reason: "credentials file" },
  { pattern: /(^|\/)oauth-tokens[^/]*\.json$/i, reason: "OAuth token file" },
  { pattern: /\.(wav|mp3|ogg|opus|m4a|flac|webm)$/i, reason: "audio recording" },
  { pattern: /\.(sqlite3?|db)$/i, reason: "local database file" },
];

const ALLOWED_ENV_EXAMPLES = /(^|\/)\.env(\.[^/]+)?\.example$/;

const TOKEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "Discord bot token",
    pattern: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
  },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Google OAuth client secret", pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Microsoft client secret", pattern: /\b[A-Za-z0-9_.~-]{3}8Q~[A-Za-z0-9_.~-]{30,}/ },
  { name: "private key block", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
];

const SECRET_NAME =
  "(?:DISCORD_BOT_TOKEN|DISCORD_TOKEN|OPENAI_API_KEY|[A-Z0-9_]*CLIENT_SECRET|[A-Z0-9_]*API_KEY|MYSQL_PASSWORD|MYSQL_ROOT_PASSWORD|DB_PASSWORD|BACKUP_ENCRYPTION_KEY)";
const ASSIGNMENT = new RegExp(`^\\s*(?:export\\s+)?(${SECRET_NAME})\\s*[=:]\\s*["']?([^"'\\s#]*)`);
// "epiphany" is the documented local-only default password (docker-compose.yml, .env.example).
const PLACEHOLDER =
  /^(?:$|your[-_]|replace[-_]|change[-_]?me|placeholder|example|<.*>|\$\{|x{3,}$|epiphany$)/i;
const DATABASE_URL_PASSWORD = /\bmysql:\/\/[^\s:/@]+:([^\s@/]+)@/i;

function isPlaceholder(value: string): boolean {
  // A "(" means a function call or expression in source code, which a literal secret never has.
  return PLACEHOLDER.test(value) || value.includes("(");
}

export function scanPath(file: string): Finding[] {
  if (ALLOWED_ENV_EXAMPLES.test(file)) return [];
  const blocked = BLOCKED_FILE_NAMES.find(({ pattern }) => pattern.test(file));
  return blocked ? [{ file, reason: `staged ${blocked.reason}` }] : [];
}

export function scanContent(file: string, content: string): Finding[] {
  if (SKIPPED_PATHS.some((pattern) => pattern.test(file))) return [];
  if (content.length > MAX_SCAN_BYTES || content.includes("\u0000")) return [];

  const findings: Finding[] = [];
  const lines = content.split("\n");
  lines.forEach((text, index) => {
    const line = index + 1;
    for (const { name, pattern } of TOKEN_PATTERNS) {
      if (pattern.test(text)) findings.push({ file, line, reason: `possible ${name}` });
    }
    const assignment = ASSIGNMENT.exec(text);
    if (assignment && !isPlaceholder(assignment[2] ?? "")) {
      findings.push({ file, line, reason: `${assignment[1]} assigned a non-placeholder value` });
    }
    const urlPassword = DATABASE_URL_PASSWORD.exec(text);
    if (urlPassword && !isPlaceholder(decodeURIComponent(urlPassword[1] ?? ""))) {
      findings.push({ file, line, reason: "database URL with a non-placeholder password" });
    }
  });
  return findings;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function findStagedSecrets(cwd: string): Finding[] {
  const files = git(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    .split("\0")
    .filter(Boolean);

  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...scanPath(file));
    let content: string;
    try {
      content = git(cwd, ["show", `:${file}`]);
    } catch {
      continue;
    }
    findings.push(...scanContent(file, content));
  }
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  return findings
    .map(({ file, line, reason }) => `- ${file}${line ? `:${line}` : ""}: ${reason}`)
    .join("\n");
}

if (import.meta.main) {
  try {
    const findings = findStagedSecrets(process.cwd());
    if (findings.length > 0) {
      console.error("Potential secrets found in staged changes (values are not printed):");
      console.error(formatFindings(findings));
      console.error("Unstage the file or replace the value with a placeholder before committing.");
      process.exit(1);
    }
    console.log("No staged secret patterns found.");
  } catch {
    console.error("Could not inspect staged changes: run this inside a git repository.");
    process.exit(2);
  }
}
