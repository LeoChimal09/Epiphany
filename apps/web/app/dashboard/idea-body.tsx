import styles from "./workspace.module.css";

export function IdeaBody({ body }: { body: string }) {
  const sections: { date: string | null; lines: string[] }[] = [{ date: null, lines: [] }];
  for (const line of body.split("\n")) {
    const heading = /^## (\d{4}-\d{2}-\d{2})$/.exec(line);
    const date = heading ? new Date(`${heading[1]}T12:00:00Z`) : null;
    if (
      heading &&
      date &&
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === heading[1]
    )
      sections.push({ date: heading[1]!, lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  return (
    <details className={styles.ideaBody}>
      <summary className={styles.ideaSummary}>Idea details</summary>
      {sections.map((section, index) => {
        const lines = section.lines.filter((line) => line.trim());
        if (!lines.length) return null;
        return (
          <section key={index}>
            {section.date ? (
              <h3>
                <time dateTime={section.date}>
                  {new Intl.DateTimeFormat("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(`${section.date}T12:00:00Z`))}
                </time>
              </h3>
            ) : null}
            {lines.map((line, lineIndex) => {
              const bullet = /^[-*•]\s+(.+)$/.exec(line.trim());
              if (!bullet) return <p key={lineIndex}>{line}</p>;
              const point = bullet[1]!;
              const label = /^([^:\n]{1,60}):\s+(.+)$/.exec(point);
              return (
                <ul key={lineIndex}>
                  <li>
                    {label ? (
                      <>
                        <strong>{label[1]}:</strong> {label[2]}
                      </>
                    ) : (
                      point
                    )}
                  </li>
                </ul>
              );
            })}
          </section>
        );
      })}
    </details>
  );
}
