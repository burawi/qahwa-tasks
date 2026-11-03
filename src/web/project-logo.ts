import { MAX_PROJECT_LOGO_BYTES, PROJECT_LOGO_SIZE_ERROR } from "../domain/project-logo.js";

export { MAX_PROJECT_LOGO_BYTES, PROJECT_LOGO_SIZE_LABEL } from "../domain/project-logo.js";
export const PROJECT_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function projectLogoValidationError(file: Pick<File, "size" | "type">): string | null {
  if (!PROJECT_LOGO_TYPES.has(file.type)) return "Choose a PNG, JPEG, or WebP image";
  if (file.size > MAX_PROJECT_LOGO_BYTES) return PROJECT_LOGO_SIZE_ERROR;
  if (file.size === 0) return "Logo file is empty";
  return null;
}
