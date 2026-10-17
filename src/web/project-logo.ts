export const MAX_PROJECT_LOGO_BYTES = 256 * 1024;
export const PROJECT_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function projectLogoValidationError(file: Pick<File, "size" | "type">): string | null {
  if (!PROJECT_LOGO_TYPES.has(file.type)) return "Choose a PNG, JPEG, or WebP image";
  if (file.size > MAX_PROJECT_LOGO_BYTES) return "Logo must be 256 KB or smaller";
  if (file.size === 0) return "Logo file is empty";
  return null;
}
