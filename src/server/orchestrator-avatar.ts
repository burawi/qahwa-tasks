import { randomUUID } from "node:crypto";
import { assertDomain } from "../domain/errors.js";
import { MAX_USER_AVATAR_BYTES, USER_AVATAR_SIZE_ERROR, type UserAvatar } from "../domain/user-avatar.js";
import type { AppDatabase } from "./database.js";
import { detectUploadedImage } from "./image-upload.js";

const SETTINGS_KEY = "orchestrator_avatar";
const IMAGE_KEY = "orchestrator_avatar_image";

export function getOrchestratorAvatar(database: AppDatabase): UserAvatar | null {
  const stored = database.setting(SETTINGS_KEY);
  return stored ? JSON.parse(stored) as UserAvatar : null;
}

export function saveOrchestratorAvatar(database: AppDatabase, bytes: Buffer, declaredMimeType: string): UserAvatar {
  assertDomain(bytes.length > 0, "Avatar file is empty", "empty_orchestrator_avatar");
  assertDomain(bytes.length <= MAX_USER_AVATAR_BYTES, USER_AVATAR_SIZE_ERROR, "orchestrator_avatar_too_large", 413);
  const detected = detectUploadedImage(bytes);
  assertDomain(detected !== null, "Avatar must be a PNG, JPEG, or WebP image", "invalid_orchestrator_avatar_type");
  assertDomain(declaredMimeType.toLowerCase() === detected.mimeType, "Avatar content does not match its file type", "orchestrator_avatar_type_mismatch");
  const version = randomUUID();
  const avatar: UserAvatar = { mimeType: detected.mimeType, size: bytes.length, version, url: `/api/settings/orchestrator/avatar/image?v=${version}` };
  // Keep metadata polling small and replace both records atomically. The bytes
  // live in SQLite, included in existing backups and independent of chat history.
  database.db.transaction(() => {
    database.setSetting(SETTINGS_KEY, JSON.stringify(avatar));
    database.setSetting(IMAGE_KEY, bytes.toString("base64"));
  })();
  return avatar;
}

export function orchestratorAvatarImage(database: AppDatabase): { bytes: Buffer; mimeType: UserAvatar["mimeType"] } {
  const avatar = getOrchestratorAvatar(database);
  const data = database.setting(IMAGE_KEY);
  assertDomain(avatar !== null && data !== null, "Orchestrator avatar not found", "orchestrator_avatar_not_found", 404);
  return { bytes: Buffer.from(data, "base64"), mimeType: avatar.mimeType };
}

export function resetOrchestratorAvatar(database: AppDatabase): null {
  database.db.transaction(() => {
    database.deleteSetting(SETTINGS_KEY);
    database.deleteSetting(IMAGE_KEY);
  })();
  return null;
}
