export function savedItemLink(kind: "task" | "todo" | "event", id: string, title: string) {
  return {
    label: `Open ${kind === "todo" ? "to-do" : kind}: ${title}`,
    href: `#${kind === "event" ? "event" : "task"}-${encodeURIComponent(id)}`,
  };
}
