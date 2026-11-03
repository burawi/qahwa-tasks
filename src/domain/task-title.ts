// Keep the quick-capture note visible until a generated title is available.
export function fallbackTaskTitle(note: string): string {
  const clean = note.trim();
  const firstLine = clean.split("\n").find(Boolean) ?? clean;
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
}

export function parseGeneratedTaskTitle(output: string): string {
  const value: unknown = JSON.parse(output);
  const title = value && typeof value === "object" && "title" in value ? value.title : null;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 100
    || /[\r\n\p{Cc}<>]/u.test(title)) throw new Error("Invalid generated task title");
  return title.trim();
}
