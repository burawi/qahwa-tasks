/** Resolve wall time by round-tripping timezone offsets, including DST folds/gaps. */
export function resolveScheduleTime(localTime: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localTime)) throw new Error("Choose a valid date and time");
  const wall = Date.parse(`${localTime}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== localTime) throw new Error("Choose a valid date and time");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (instant: number) => Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type, p.value]));
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = wall + hours * 3_600_000;
    const p = parts(instant);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - instant);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => {
    const p = parts(instant);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === localTime;
  });
  if (candidates.length !== 1) throw new Error(candidates.length ? "This local time occurs twice. Choose an unambiguous time." : "This local time does not exist. Choose another time.");
  return new Date(candidates[0]!).toISOString();
}

export function scheduleZoneLabel(runAt: string, timezone: string): string {
  const offset = new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(new Date(runAt)).find(p => p.type === "timeZoneName")?.value ?? "GMT";
  return `${timezone} (${offset === "GMT" ? "UTC+00:00" : offset.replace("GMT", "UTC")})`;
}
