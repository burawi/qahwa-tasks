import { api } from "./api";

function supported(): boolean {
  return window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

/** Inspect existing permission only; page loads must never prompt. */
export async function appNotificationsReady(): Promise<boolean> {
  if (!supported() || Notification.permission !== "granted") return false;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration || !await registration.pushManager.getSubscription()) return false;
  return (await api.appPushSettings()).subscribed;
}

/** Called directly from a user click so the browser permission prompt is allowed. */
export async function enableAppNotifications(): Promise<void> {
  if (!supported()) throw new Error("App notifications are unavailable in this browser. Open Qahwa Tasks in a supported browser or installed app.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed. Allow notifications for Qahwa Tasks in your browser or device settings, then try again.");
  await navigator.serviceWorker.register("/sw.js");
  let timer: ReturnType<typeof setTimeout>;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("App notifications could not start. Reload and try again.")), 15_000); }),
  ]).finally(() => clearTimeout(timer));
  const { publicKey } = await api.appPushSettings();
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  let subscription = await registration.pushManager.getSubscription();
  const existingKey = subscription?.options.applicationServerKey;
  if (subscription && existingKey && !new Uint8Array(existingKey).every((byte, index) => byte === key[index])) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.saveAppPushSubscription(subscription.toJSON());
}
