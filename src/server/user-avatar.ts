import { randomUUID } from "node:crypto";
import { assertDomain } from "../domain/errors.js";
import { MAX_USER_AVATAR_BYTES, USER_AVATAR_SIZE_ERROR, type UserAvatar } from "../domain/user-avatar.js";
import type { AppDatabase } from "./database.js";
import { detectUploadedImage } from "./image-upload.js";

const SETTINGS_KEY = "user_avatar";
const IMAGE_KEY = "user_avatar_image";

export function getUserAvatar(database: AppDatabase): UserAvatar | null {
  const stored = database.setting(SETTINGS_KEY);
  return stored ? JSON.parse(stored) as UserAvatar : null;
}

export function saveUserAvatar(database: AppDatabase, bytes: Buffer, declaredMimeType: string): UserAvatar {
  assertDomain(bytes.length > 0, "Avatar file is empty", "empty_user_avatar");
  assertDomain(bytes.length <= MAX_USER_AVATAR_BYTES, USER_AVATAR_SIZE_ERROR, "user_avatar_too_large", 413);
  const detected = detectUploadedImage(bytes);
  assertDomain(detected !== null, "Avatar must be a PNG, JPEG, or WebP image", "invalid_user_avatar_type");
  assertDomain(declaredMimeType.toLowerCase() === detected.mimeType, "Avatar content does not match its file type", "user_avatar_type_mismatch");
  const version = randomUUID();
  const avatar: UserAvatar = { mimeType: detected.mimeType, size: bytes.length, version, url: `/api/settings/avatar/image?v=${version}` };
  // Keep metadata polling small and replace both records atomically. The bytes
  // live in SQLite, included in existing backups and independent of chat history.
  database.db.transaction(() => {
    database.setSetting(SETTINGS_KEY, JSON.stringify(avatar));
    database.setSetting(IMAGE_KEY, bytes.toString("base64"));
  })();
  return avatar;
}

export function userAvatarImage(database: AppDatabase): { bytes: Buffer; mimeType: UserAvatar["mimeType"] } {
  const avatar = getUserAvatar(database);
  const data = database.setting(IMAGE_KEY);
  assertDomain(avatar !== null && data !== null, "User avatar not found", "user_avatar_not_found", 404);
  return { bytes: Buffer.from(data, "base64"), mimeType: avatar.mimeType };
}

export function resetUserAvatar(database: AppDatabase): null {
  database.db.transaction(() => {
    database.deleteSetting(SETTINGS_KEY);
    database.deleteSetting(IMAGE_KEY);
  })();
  return null;
}
