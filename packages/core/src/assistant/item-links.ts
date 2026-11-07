export function savedItemLink(
  kind: "task" | "todo" | "event" | "note" | "idea",
  id: string,
  title: string,
) {
  return {
    label: `Open ${kind === "todo" ? "to-do" : kind}: ${title}`,
    href: `#${kind === "event" ? "event" : kind === "note" || kind === "idea" ? "note" : "task"}-${encodeURIComponent(id)}`,
  };
}
