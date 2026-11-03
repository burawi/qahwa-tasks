import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Download, FileText, Film, Image as ImageIcon, LoaderCircle, Music2, Play, RotateCcw, X } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ChatAttachment, ChatMessage, TaskArtifact } from "../../domain/types";
import { fetchMessageFile } from "../api";
import { attachmentResource, messageResource, previewKind, type MessageResource } from "../message-resource";
import { blockCopyText } from "../block-copy";
import { BlockCopyButton } from "./BlockCopyButton";
import "../message-media.css";

export const MessageResources = createContext<{ artifacts: TaskArtifact[]; root: string }>({ artifacts: [], root: "" });
const MessageAttachments = createContext<ChatAttachment[]>([]);
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
// Preserve file references until our scoped resolver handles them. Native DOM
// attributes still receive only resolved API/blob URLs, never filesystem URLs.
const messageSchema = { ...defaultSchema, protocols: { ...defaultSchema.protocols,
  href: [...(defaultSchema.protocols?.href ?? []), "file", "sandbox"],
  src: [...(defaultSchema.protocols?.src ?? []), "file", "sandbox"],
} };

function PreviewDialog({ url, name, close }: { url: string; name: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return createPortal(<dialog ref={ref} className="message-image-dialog" aria-label={name} onClose={close} onClick={event => {
    if (event.target === event.currentTarget) ref.current?.close();
  }}><span className="message-image-dialog-header"><span>{name}</span><button type="button" onClick={() => ref.current?.close()} autoFocus aria-label="Close image preview"><X aria-hidden="true" /></button></span><img src={url} alt={name} /></dialog>, document.body);
}

function ResourceView({ resource, children, image = false, label = resource.filename }: { resource: MessageResource; children?: ReactNode; image?: boolean; label?: string }) {
  const [loaded, setLoaded] = useState<{ url: string; kind: MessageResource["kind"]; text?: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [requested, setRequested] = useState(false);
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const downloadLock = useRef(false);
  const mounted = useRef(true);
  const kind = image ? "image" : resource.kind;
  const automatic = kind === "image" || (!resource.protected && (kind === "audio" || kind === "video"));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setLoaded(undefined); setError(undefined); setExpanded(false);
    if (!resource.url || resource.unavailable || (!automatic && !requested)) { setLoading(false); return; }
    if (!resource.protected) {
      setLoaded({ url: resource.url, kind });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoading(true);
    void fetchMessageFile(resource.url, { ...resource, signal: controller.signal, limit: MAX_PREVIEW_BYTES }).then(async blob => {
      const resolvedKind = image ? "image" : previewKind(blob.type, resource.filename);
      const text = resolvedKind === "text" ? await blob.text() : undefined;
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ url: objectUrl, kind: resolvedKind, text });
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Preview unavailable");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [resource.url, resource.unavailable, resource.protected, resource.size, resource.mediaType, resource.filename, resource.attachment, automatic, requested, retry, kind, image]);

  const download = async () => {
    if (!resource.url || downloadLock.current) return;
    downloadLock.current = true; setDownloading(true); setError(undefined);
    try {
      const blob = await fetchMessageFile(resource.url, resource);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = resource.filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Download failed");
    } finally {
      downloadLock.current = false;
      if (mounted.current) setDownloading(false);
    }
  };
  const available = resource.url && !resource.unavailable;
  const effectiveKind = loaded?.kind ?? kind;
  const showPreview = !error && loaded;
  const Icon = effectiveKind === "image" ? ImageIcon : effectiveKind === "video" ? Film : effectiveKind === "audio" ? Music2 : FileText;
  const typeLabel = { image: "Image", video: "Video", audio: "Audio", pdf: "PDF document", text: "Text document", none: "File" }[effectiveKind];
  const sizeLabel = resource.size === undefined ? null : resource.size < 1024 ? `${resource.size} B` : resource.size < 1024 ** 2 ? `${(resource.size / 1024).toFixed(1)} KiB` : `${(resource.size / 1024 ** 2).toFixed(1)} MiB`;
  return <span className={`message-resource kind-${effectiveKind}`}>
    <span className="message-resource-header">
      <span className="message-resource-icon" aria-hidden="true"><Icon /></span>
      <span className="message-resource-copy">
        {available && !resource.protected ? <a className="message-resource-name" href={resource.url!} target="_blank" rel="noopener noreferrer external">{children ?? resource.filename}<ArrowUpRight aria-hidden="true" /></a> : <span className="message-resource-name">{children ?? resource.filename}</span>}
        <small className="message-resource-meta">{typeLabel}{sizeLabel && <> · {sizeLabel}</>}</small>
      </span>
      {(resource.protected || resource.attachment) && <button className="message-media-download" type="button" disabled={!available || downloading} title={`Download ${resource.filename}`} onClick={() => void download()}>
        {downloading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}<span className="message-media-sr-only">{downloading ? "Downloading…" : <>Download {children ?? resource.filename}</>}</span>
      </button>}
    </span>
    {available && !automatic && !loaded && !loading && (kind !== "none" || resource.protected) && <span className={`message-media-placeholder${kind === "video" ? " video-placeholder" : ""}`}><button className="message-media-load" type="button" onClick={() => { setRequested(true); setRetry(value => value + 1); }}><span className="message-media-load-icon" aria-hidden="true">{kind === "audio" || kind === "video" ? <Play /> : <FileText />}</span>{kind === "audio" || kind === "video" ? "Load player" : "Preview"}</button></span>}
    {resource.unavailable && <small className="message-media-status" role="status">{resource.unavailable}</small>}
    {loading && <small className="message-media-status" role="status"><LoaderCircle className="spin" aria-hidden="true" />Loading preview…</small>}
    {error && <span className="message-media-error" role="status"><span>{error}</span>{available && <button type="button" onClick={() => { setError(undefined); setRequested(true); setRetry(value => value + 1); }}><RotateCcw aria-hidden="true" />Retry preview</button>}</span>}
    {showPreview && effectiveKind === "image" && <button className="message-image-button" type="button" aria-label={`Preview ${label}`} onClick={() => setExpanded(true)}><img src={loaded.url} alt={label} loading="lazy" onError={() => setError("Image preview unavailable. Use the link or download.")} /></button>}
    {showPreview && effectiveKind === "video" && <video src={loaded.url} controls playsInline preload="metadata" aria-label={resource.filename} onError={() => setError("Video playback unavailable. Use the link or download.")} />}
    {showPreview && effectiveKind === "audio" && <span className="message-audio-player"><audio src={loaded.url} controls preload="metadata" aria-label={resource.filename} onError={() => setError("Audio playback unavailable. Use the link or download.")} /></span>}
    {showPreview && effectiveKind === "pdf" && <iframe src={loaded.url} title={`Preview ${resource.filename}`} sandbox="" loading="lazy" />}
    {showPreview && effectiveKind === "text" && loaded.text !== undefined && <span className="message-text-preview">{loaded.text.slice(0, 100_000)}{loaded.text.length > 100_000 ? "\nPreview truncated. Download for the full file." : ""}</span>}
    {showPreview && effectiveKind === "none" && <small className="message-media-status">Preview unavailable for this file type. Use Download.</small>}
    {expanded && loaded && <PreviewDialog url={loaded.url} name={label} close={() => setExpanded(false)} />}
  </span>;
}

function useMessageResource(url = "") {
  const { artifacts, root } = useContext(MessageResources);
  const attachments = useContext(MessageAttachments);
  const attachment = attachments.find(item => item.previewUrl === url);
  return attachment ? attachmentResource(attachment) : messageResource(url, artifacts, root);
}

// Stable component identities preserve media playback and image decoding when
// polling updates context or appends messages.
const markdownComponents: Components = {
  pre: function CopyableCode({ node, children }) {
    return <div className="copyable-code"><div className="block-copy-header"><BlockCopyButton text={node ? blockCopyText(node) : ""} label="Copy code" /></div><pre>{children}</pre></div>;
  },
  blockquote: function CopyableQuote({ node, children }) {
    return <blockquote><div className="block-copy-header"><BlockCopyButton text={node ? blockCopyText(node) : ""} label="Copy quote" /></div>{children}</blockquote>;
  },
  a: function MessageLink({ href, children, node }) {
    const resource = useMessageResource(href);
    if (node?.children.some(child => child.type === "element" && child.tagName === "img")) return <span>{children}{resource.url && !resource.protected && <a href={resource.url} target="_blank" rel="noopener noreferrer external">Open link</a>}</span>;
    if (resource.protected || resource.kind === "image" || resource.kind === "audio" || resource.kind === "video" || resource.kind === "pdf") return <ResourceView resource={resource}>{children}</ResourceView>;
    return resource.url ? <a href={resource.url} target="_blank" rel="noopener noreferrer external">{children}</a> : <span title={resource.unavailable}>{children} <small>(link unavailable)</small></span>;
  },
  img: function MessageImage({ src, alt }) {
    const resource = useMessageResource(typeof src === "string" ? src : "");
    return <ResourceView resource={resource} image label={alt || resource.filename} />;
  },
};

export function MessageBody({ entry }: { entry: ChatMessage }) {
  const inherited = useContext(MessageResources);
  const resources = { ...inherited, artifacts: [...(entry.metadata?.files ?? []), ...inherited.artifacts] };
  return <><MessageResources.Provider value={resources}><MessageAttachments.Provider value={entry.metadata?.attachments ?? []}><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, messageSchema]]}
    urlTransform={value => value} components={markdownComponents}>{entry.body}</ReactMarkdown></div></MessageAttachments.Provider></MessageResources.Provider>
    {entry.metadata?.attachments?.length ? <div className="message-attachments">{entry.metadata.attachments.map(attachment => <ResourceView key={attachment.id} resource={attachmentResource(attachment)} />)}</div> : null}</>;
}
