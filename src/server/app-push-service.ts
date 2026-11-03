import { createHash } from "node:crypto";
import webpush from "web-push";
import { assertDomain } from "../domain/errors.js";
import type { AppDatabase } from "./database.js";
import type { Config } from "./config.js";

export interface AppNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
}

type SubscriptionRow = { device_id: string; endpoint: string; subscription_json: string };

export class AppPushService {
  constructor(private readonly database: AppDatabase, private readonly config: Pick<Config, "publicBaseUrl">,
    private readonly sendNotification: typeof webpush.sendNotification = webpush.sendNotification) {}

  settings(deviceId: string): { publicKey: string; subscribed: boolean } {
    return { publicKey: this.keys().publicKey,
      subscribed: Boolean(this.database.db.prepare("SELECT 1 FROM app_push_subscriptions WHERE device_id = ?").get(deviceId)) };
  }

  subscribe(deviceId: string, input: unknown): void {
    const device = this.database.db.prepare("SELECT 1 FROM paired_devices WHERE id = ? AND revoked_at IS NULL").get(deviceId);
    assertDomain(device, "Pair this device before enabling notifications", "device_required", 401);
    const value = input as Partial<webpush.PushSubscription> | null;
    assertDomain(value && typeof value.endpoint === "string" && value.endpoint.length <= 4096, "Invalid push subscription", "invalid_push_subscription");
    let endpoint: URL;
    try { endpoint = new URL(value.endpoint); } catch { assertDomain(false, "Invalid push endpoint", "invalid_push_subscription"); }
    // A subscription cannot turn the paired API into a sender to arbitrary hosts.
    const host = endpoint.hostname;
    const provider = host === "fcm.googleapis.com" || host === "web.push.apple.com"
      || host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com")
      || host.endsWith(".notify.windows.com");
    assertDomain(endpoint.protocol === "https:" && provider && !endpoint.username && !endpoint.password && (!endpoint.port || endpoint.port === "443"),
      "Unsupported push subscription endpoint", "invalid_push_subscription");
    const validKey = (key: unknown, length: number) => typeof key === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(key)
      && Buffer.from(key, "base64url").length === length;
    assertDomain(validKey(value.keys?.p256dh, 65) && validKey(value.keys?.auth, 16)
      && Buffer.from(value.keys!.p256dh, "base64url")[0] === 4, "Invalid push subscription keys", "invalid_push_subscription");
    const existing = this.database.db.prepare("SELECT device_id FROM app_push_subscriptions WHERE endpoint = ?").get(value.endpoint) as { device_id: string } | undefined;
    assertDomain(!existing || existing.device_id === deviceId, "This browser is already registered to another paired device", "push_subscription_conflict", 409);
    const subscription: webpush.PushSubscription = { endpoint: value.endpoint, keys: { p256dh: value.keys!.p256dh, auth: value.keys!.auth } };
    this.database.db.prepare(`INSERT INTO app_push_subscriptions(device_id,endpoint,subscription_json,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint, subscription_json=excluded.subscription_json, updated_at=excluded.updated_at`)
      .run(deviceId, subscription.endpoint, JSON.stringify(subscription), new Date().toISOString());
  }

  unsubscribe(deviceId: string): void {
    this.database.db.prepare("DELETE FROM app_push_subscriptions WHERE device_id = ?").run(deviceId);
  }

  async send(notification: AppNotification): Promise<number> {
    const rows = this.database.db.prepare(`SELECT s.device_id,s.endpoint,s.subscription_json FROM app_push_subscriptions s
      JOIN paired_devices d ON d.id=s.device_id WHERE d.revoked_at IS NULL`).all() as SubscriptionRow[];
    if (!rows.length) return 0;
    const keys = this.keys();
    const results = await Promise.all(rows.map(async row => {
      try {
        await this.sendNotification(JSON.parse(row.subscription_json) as webpush.PushSubscription, JSON.stringify(notification), {
          vapidDetails: { ...keys, subject: process.env.WEB_PUSH_SUBJECT?.trim() || this.config.publicBaseUrl },
          TTL: 3600, urgency: "high", timeout: 10_000,
          topic: createHash("sha256").update(notification.tag).digest("base64url").slice(0, 32),
        });
        return 1;
      } catch (error) {
        if ([404, 410].includes(Number((error as { statusCode?: number })?.statusCode))) {
          this.database.db.prepare("DELETE FROM app_push_subscriptions WHERE device_id = ? AND endpoint = ?").run(row.device_id, row.endpoint);
        }
        return 0;
      }
    }));
    return results.reduce<number>((sum, count) => sum + count, 0);
  }

  private keys(): { publicKey: string; privateKey: string } {
    const stored = this.database.setting("app_push_vapid_keys");
    if (stored) return JSON.parse(stored) as { publicKey: string; privateKey: string };
    const keys = webpush.generateVAPIDKeys();
    this.database.setSetting("app_push_vapid_keys", JSON.stringify(keys));
    return keys;
  }
}
