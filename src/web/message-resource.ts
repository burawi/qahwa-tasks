import type { ChatAttachment, TaskArtifact } from "../domain/types";

export type PreviewKind = "image" | "audio" | "video" | "pdf" | "text" | "none";
export interface MessageResource {
  url: string | null;
  filename: string;
  kind: PreviewKind;
  protected: boolean;
  size?: number;
  mediaType?: string;
  attachment?: boolean;
  unavailable?: string;
}

export function previewKind(mediaType = "", filename = ""): PreviewKind {
  const mime = mediaType.split(";", 1)[0]!.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (/^(text\/(plain|markdown|csv)|application\/json)$/.test(mime)) return "text";
  const extension = filename.split(/[?#]/, 1)[0]!.split(".").at(-1)?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(extension!)) return "image";
  if (["mp4", "webm", "mov", "ogv"].includes(extension!)) return "video";
  if (["mp3", "m4a", "wav", "ogg", "oga", "aac", "flac", "opus"].includes(extension!)) return "audio";
  if (extension === "pdf") return "pdf";
  if (["txt", "md", "csv", "json", "log"].includes(extension!)) return "text";
  return "none";
}

export function attachmentResource(attachment: ChatAttachment): MessageResource {
  return {
    url: attachment.previewUrl, filename: attachment.filename, size: attachment.size,
    mediaType: attachment.mediaType, kind: previewKind(attachment.mediaType, attachment.filename),
    protected: true, attachment: true,
    unavailable: attachment.status === "expired" ? "File expired" : undefined,
  };
}

const protectedPath = /^\/api\/(?:tasks\/[^/]+\/(?:outputs\/[^/]+\/artifacts\/\d+|attachments\/[^/]+|files\/[^/]+)|orchestrator\/(?:attachments|files)\/[^/]+)$/;

export function taskIdFromPath(pathname: string): string | null {
  const match = /^\/tasks\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]!);
    return /^[a-z\d-]+$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Local paths are resolved only against artifacts already authorized by the server.
export function messageResource(value: string, artifacts: TaskArtifact[] = [], root = ""): MessageResource {
  let decoded = value;
  try { decoded = decodeURI(value); } catch { /* Malformed escapes remain displayable. */ }
  const local = decoded.replace(/^file:\/\//i, "").replace(/:\d+(?::\d+)?$/, "");
  const absolute = (path: string) => path.startsWith("/") ? path : `${root.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
  const artifact = artifacts.find(item => item.sourceType === "path" && (item.source === value || item.source === local || absolute(item.source) === absolute(local)));
  if (artifact) return {
    url: artifact.previewUrl, filename: artifact.filename, protected: true,
    size: artifact.size ?? undefined, mediaType: artifact.mediaType ?? undefined,
    kind: artifact.previewKind === "none" ? "none" : previewKind(artifact.mediaType ?? "", artifact.filename),
    unavailable: artifact.previewUrl ? undefined : "File unavailable or outside the project",
  };
  try {
    const url = new URL(value, "https://qahwa.invalid");
    const internal = !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith("//");
    const filename = decodeURIComponent(url.pathname.split("/").at(-1) || "file");
    if (internal && value.startsWith("/") && /^\/(?:tasks\/[a-z\d-]+|orchestrator)?$/i.test(url.pathname)) return {
      url: url.pathname + url.search + url.hash, filename, protected: false, kind: "none",
    };
    if (internal && protectedPath.test(url.pathname)) return {
      url: url.pathname + url.search, filename, protected: true, kind: previewKind("", filename),
      attachment: url.pathname.includes("/attachments/"),
    };
    if (/^https?:\/\//i.test(value) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.hostname !== "qahwa.invalid") {
      // API paths in absolute links still require the encrypted connection when same-origin.
      if (typeof location !== "undefined" && url.origin === location.origin && protectedPath.test(url.pathname)) {
        return { url: url.pathname + url.search, filename, protected: true, kind: previewKind("", filename), attachment: url.pathname.includes("/attachments/") };
      }
      return { url: url.href, filename, kind: previewKind("", filename), protected: false };
    }
    if (["mailto:", "tel:"].includes(url.protocol)) return { url: value, filename: value, kind: "none", protected: false };
  } catch { /* Never let an invalid URL escape into rendering/navigation. */ }
  return { url: null, filename: value || "file", kind: "none", protected: false, unavailable: "Link unavailable" };
}
