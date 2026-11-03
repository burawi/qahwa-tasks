/** Serializes unsubscribe with the next resume without changing persisted threads. */
export class SessionResources {
  private readonly releasing = new Map<string, Promise<void>>();
  private readonly unsubscribed = new Set<string>();

  constructor(private readonly unsubscribe: (threadId: string) => Promise<unknown>) {}

  isReleased(threadId: string): boolean { return this.unsubscribed.has(threadId); }

  beforeResume(threadId: string): Promise<void> | undefined {
    const pending = this.releasing.get(threadId);
    this.unsubscribed.delete(threadId);
    // Leave the normal queue/startup ordering intact when nothing is releasing.
    // A failed unsubscribe is recoverable by resume, which subscribes again.
    return pending?.catch(() => undefined).then(() => { this.unsubscribed.delete(threadId); });
  }

  release(threadId: string, eligible: () => boolean): Promise<void> {
    const pending = this.releasing.get(threadId);
    if (pending) return pending;
    if (this.unsubscribed.has(threadId) || !eligible()) return Promise.resolve();
    // Defer RPC ingress until the promise is installed, including synchronous test transports.
    const operation = Promise.resolve().then(async () => {
      if (!eligible()) return;
      await this.unsubscribe(threadId);
      this.unsubscribed.add(threadId);
    }).finally(() => this.releasing.delete(threadId));
    this.releasing.set(threadId, operation);
    return operation;
  }

  reset(): void { this.unsubscribed.clear(); }
}
