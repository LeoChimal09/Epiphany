import styles from "./workspace.module.css";

function inline(text: string) {
  return text
    .split(/(\*\*[^*\n]+\*\*)/)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}

export function RecordText({ body }: { body: string }) {
  const blocks: { kind: "paragraph" | "ul" | "ol" | "heading"; lines: string[] }[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      blocks.push({ kind: "paragraph", lines: [] });
      continue;
    }
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    const bullet = /^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    const kind = heading ? "heading" : bullet ? (/^\d/.test(line) ? "ol" : "ul") : "paragraph";
    const content = heading?.[1] ?? bullet?.[1] ?? raw;
    const last = blocks.at(-1);
    if (kind !== "heading" && last?.kind === kind) last.lines.push(content);
    else blocks.push({ kind, lines: [content] });
  }
  return (
    <div className={styles.recordText}>
      {blocks.map((block, index) => {
        if (!block.lines.length) return null;
        if (block.kind === "heading") return <h3 key={index}>{inline(block.lines[0]!)}</h3>;
        if (block.kind === "paragraph") return <p key={index}>{inline(block.lines.join("\n"))}</p>;
        const List = block.kind;
        return (
          <List key={index}>
            {block.lines.map((line, lineIndex) => {
              const label = /^([^:\n]{1,60}):\s+(.+)$/.exec(line);
              return (
                <li key={lineIndex}>
                  {label ? (
                    <>
                      <strong>{label[1]}:</strong> {inline(label[2]!)}
                    </>
                  ) : (
                    inline(line)
                  )}
                </li>
              );
            })}
          </List>
        );
      })}
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function logDate(line: string): string | null {
  const heading = /^## (\d{4}-\d{2}-\d{2})$/.exec(line.trim());
  if (!heading) return null;
  const date = new Date(`${heading[1]}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === heading[1]
    ? heading[1]!
    : null;
}

// Dated sections form the update log; other text, including non-date "## " sections, is kept.
export function splitRecord(body: string): {
  details: string;
  log: { date: string; text: string }[];
} {
  const log: { date: string; lines: string[] }[] = [];
  const details: string[] = [];
  let inLog = false;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const date = logDate(line);
    if (date) {
      log.push({ date, lines: [] });
      inLog = true;
      continue;
    }
    // A non-date "## " section is kept content, even when it follows a log day.
    if (/^## \S/.test(line.trim())) inLog = false;
    (inLog ? log.at(-1)!.lines : details).push(line);
  }
  return {
    details: details.join("\n").trim(),
    log: log
      .map((entry) => ({ date: entry.date, text: entry.lines.join("\n").trim() }))
      .filter((entry) => entry.text),
  };
}

export function recordPreview(body: string): string {
  const { details, log } = splitRecord(body);
  const text = (details || log.map((entry) => entry.text).join("\n"))
    .split("\n")
    .map((line) => line.replace(/^#{1,4}\s+|^[-*•]\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

export function IdeaBody({ body, label = "Idea details" }: { body: string; label?: string }) {
  const { details, log } = splitRecord(body);
  if (!details && !log.length) return null;
  return (
    <div className={styles.recordSections}>
      {details ? (
        <details className={styles.ideaBody}>
          <summary className={styles.ideaSummary}>
            <span>{label}</span>
          </summary>
          <section>
            <RecordText body={details} />
          </section>
        </details>
      ) : null}
      {log.length ? (
        <details className={styles.ideaBody}>
          <summary className={styles.ideaSummary}>
            <span>Update log</span>
            <small>
              {log.length} {log.length === 1 ? "day" : "days"}
            </small>
          </summary>
          {log.map((entry) => (
            <section key={entry.date} className={styles.ideaLogEntry}>
              <h3>
                <time dateTime={entry.date}>
                  {dateFormat.format(new Date(`${entry.date}T12:00:00Z`))}
                </time>
              </h3>
              <RecordText body={entry.text} />
            </section>
          ))}
        </details>
      ) : null}
    </div>
  );
}
