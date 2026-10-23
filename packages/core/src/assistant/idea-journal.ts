const dateHeading = /^## (\d{4}-\d{2}-\d{2})$/;
const withoutBullet = (value: string) => value.trim().replace(/^[-*•]\s+/, "");
const labelPattern = /^([^:\n]{1,60}):\s+(.+)$/;
const pointKey = (value: string) => {
  const point = withoutBullet(value);
  return (labelPattern.exec(point)?.[2] ?? point).toLowerCase();
};

export function appendIdeaPoints(
  body: string,
  points: string[],
  createdDate: string,
  today: string,
): { body: string; additions: string[] } {
  const existing = new Set(body.split("\n").map(pointKey));
  const additions: string[] = [];
  for (const value of points) {
    const point = withoutBullet(value);
    const key = pointKey(point);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    additions.push(labelPattern.test(point) ? point : `Note: ${point}`);
  }
  if (!additions.length) return { body, additions };

  const lines = body.trimEnd().split("\n");
  if (!dateHeading.test(lines[0]!)) {
    lines.unshift(`## ${createdDate}`, "");
  }
  const heading = lines.indexOf(`## ${today}`);
  const bullets = additions.map((point) => `- ${point}`);
  if (heading === -1) {
    lines.push("", `## ${today}`, "", ...bullets);
  } else {
    const next = lines.findIndex((line, index) => index > heading && dateHeading.test(line));
    let end = next === -1 ? lines.length : next;
    while (end > heading + 1 && !lines[end - 1]!.trim()) end--;
    lines.splice(end, 0, "", ...bullets);
  }
  return { body: lines.join("\n"), additions };
}
