export const MAX_USER_AVATAR_BYTES = 20 * 1024 * 1024;
export const USER_AVATAR_SIZE_LABEL = `${MAX_USER_AVATAR_BYTES / (1024 * 1024)} MiB`;
export const USER_AVATAR_SIZE_ERROR = `Avatar must be ${USER_AVATAR_SIZE_LABEL} or smaller`;

export interface UserAvatar {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  version: string;
  url: string;
}

export function userAvatarValidationError(file: { size: number; type: string }): string | null {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return "Choose a PNG, JPEG, or WebP image";
  if (file.size > MAX_USER_AVATAR_BYTES) return USER_AVATAR_SIZE_ERROR;
  if (file.size === 0) return "Avatar file is empty";
  return null;
}
