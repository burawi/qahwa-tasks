import { readFileSync, readdirSync } from "node:fs";
import { assertDomain } from "../domain/errors.js";

export interface TerminalProcessOwner { pid: number; parent: number; session: number; started: string; state: string }

function identity(pid: number): TerminalProcessOwner | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0]!, parent: Number(fields[1]), session: Number(fields[3]), started: fields[19]! };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

/** A PTY creates a dedicated Linux session. Jobs have separate process groups,
 * so killing only the PTY's foreground group leaves background work running. */
export function terminalProcessOwner(pid: number): TerminalProcessOwner | undefined {
  // forkpty may return before its child calls setsid. Capture the birth identity
  // now, then verify the dedicated session when termination is requested.
  return identity(pid);
}

export async function stopTerminalProcesses(shell: TerminalProcessOwner | undefined, generation: string): Promise<void> {
  const currentShell = shell && identity(shell.pid);
  const pid = shell && (!currentShell || currentShell.started === shell.started) ? shell.pid : undefined;
  assertDomain(pid !== process.pid && (!currentShell || pid === undefined || currentShell.session === pid),
    "Could not verify shell ownership", "terminal_ownership", 409);
  const owned = new Map<number, TerminalProcessOwner>(pid !== undefined && shell ? [[pid, shell]] : []);
  const inheritedOwnership = (item: TerminalProcessOwner) => {
    if (item.state === "Z" || item.state === "X") return false;
    try {
      // Detached/reparented jobs inherit this unique shell-generation marker.
      // Inspect only for the marker; never retain or log process environments.
      const environment = readFileSync(`/proc/${item.pid}/environ`);
      return Buffer.concat([Buffer.from([0]), environment]).includes(Buffer.from(`\0QAHWA_TERMINAL_GENERATION=${generation}\0`));
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  };
  const collect = () => {
    const processes = readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => identity(Number(name)) ?? []);
    // Keep previously identified descendants even if they detach/reparent.
    const current = new Map(processes.map(item => [item.pid, item]));
    for (const item of owned.values()) {
      const next = current.get(item.pid);
      if (next?.started !== item.started) owned.delete(item.pid);
      else owned.set(item.pid, next);
    }
    for (const item of processes) if (!owned.has(item.pid) && inheritedOwnership(item)) owned.set(item.pid, item);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of processes) {
        if (!owned.has(item.pid) && ((pid !== undefined && item.session === pid) || owned.has(item.parent))) {
          owned.set(item.pid, item); changed = true;
        }
      }
    }
    return [...owned.values()].filter(item => item.state !== "Z" && item.state !== "X");
  };
  const signal = (items: TerminalProcessOwner[], value: NodeJS.Signals) => {
    // Signal children before the shell, and verify identity to avoid PID reuse.
    for (const item of items.sort((a, b) => Number(a.pid === pid) - Number(b.pid === pid))) {
      if (identity(item.pid)?.started !== item.started) continue;
      try { process.kill(item.pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  };
  const deadline = Date.now() + 2000;
  const gracefulUntil = Date.now() + 350;
  for (;;) {
    const remaining = collect();
    if (!remaining.length) return;
    assertDomain(Date.now() < deadline, "Shell workload did not stop. Retry stopping this terminal.", "terminal_stop_failed", 409);
    signal(remaining, Date.now() < gracefulUntil ? "SIGTERM" : "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
