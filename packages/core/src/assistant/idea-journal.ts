const dateHeading = /^## (\d{4}-\d{2}-\d{2})$/;
// Any other level-2 heading starts kept content again, so it never hides inside a log day.
const sectionHeading = /^## (?!\d{4}-\d{2}-\d{2}$)\S/;
const lf = (value: string) => value.replace(/\r\n?/g, "\n");
const withoutBullet = (value: string) => value.trim().replace(/^[-*•]\s+/, "");
const labelPattern = /^([^:\n]{1,60}):\s+(.+)$/;
const editorialLabel =
  /^(?:note|feature|concern|suggestion|question|decision|action|risk|update|goal|problem|constraint|benefit)$/i;
const pointKey = (value: string) => {
  const point = withoutBullet(value);
  const labeled = labelPattern.exec(point);
  return (labeled && editorialLabel.test(labeled[1]!) ? labeled[2]! : point).toLowerCase();
};

export function appendIdeaPoints(
  body: string,
  points: string[],
  today: string,
): { body: string; additions: string[] } {
  const existing = new Set(body.split("\n").map(pointKey));
  const additions: string[] = [];
  for (const value of points) {
    const point = withoutBullet(value);
    const key = pointKey(point);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    additions.push(labelPattern.test(point) || /^#{1,4}\s/.test(point) ? point : `Note: ${point}`);
  }
  if (!additions.length) return { body, additions };

  const lines = lf(body).trimEnd().split("\n");
  if (lines.length === 1 && !lines[0]) lines.length = 0;
  const heading = lines.indexOf(`## ${today}`);
  const bullets = additions.map((point) => (/^#{1,4}\s/.test(point) ? point : `- ${point}`));
  if (heading === -1) {
    lines.push(...(lines.length ? [""] : []), `## ${today}`, "", ...bullets);
  } else {
    const next = lines.findIndex(
      (line, index) =>
        index > heading && (dateHeading.test(line.trim()) || sectionHeading.test(line.trim())),
    );
    let end = next === -1 ? lines.length : next;
    while (end > heading + 1 && !lines[end - 1]!.trim()) end--;
    lines.splice(end, 0, "", ...bullets);
  }
  return { body: lines.join("\n"), additions };
}

// Dated sections are the record's log; everything else (text before the first date, or a
// non-date "## " section after one) is its kept details.
export function splitRecordBody(body: string): { details: string; log: string } {
  const details: string[] = [];
  const log: string[] = [];
  let inLog = false;
  for (const line of lf(body).split("\n")) {
    const text = line.trim();
    if (dateHeading.test(text)) inLog = true;
    else if (sectionHeading.test(text)) inLog = false;
    (inLog ? log : details).push(line);
  }
  return { details: details.join("\n").trim(), log: log.join("\n").trim() };
}

// Replaces the kept details and records the change in today's log section.
export function reviseRecordBody(
  body: string,
  details: string,
  logLine: string,
  today: string,
): string {
  const { log } = splitRecordBody(body);
  const point = withoutBullet(logLine.replace(/\s+/g, " "));
  const logged = appendIdeaPoints(
    log,
    [/^[^:\n]{1,60}:\s/.test(point) ? point : `Update: ${point}`],
    today,
  );
  const nextLog = logged.additions.length ? logged.body : log;
  return [details.trim(), nextLog.trim()].filter(Boolean).join("\n\n");
}
