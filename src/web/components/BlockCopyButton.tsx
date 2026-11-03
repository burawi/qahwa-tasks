import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "../block-copy.css";

export function BlockCopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const pending = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    setStatus("idle");
    return () => { generation.current++; clearTimeout(timer.current); };
  }, [text]);
  const copy = async () => {
    if (pending.current) return;
    pending.current = true;
    const current = generation.current;
    clearTimeout(timer.current);
    setStatus("idle");
    let result: "copied" | "failed" = "copied";
    try { await navigator.clipboard.writeText(text); }
    catch { result = "failed"; }
    finally { pending.current = false; }
    if (current !== generation.current) return;
    setStatus(result);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
  };
  return <span className="block-copy-action">
    <span className="block-copy-status" role="status">{status === "copied" ? "Copied" : status === "failed" ? "Copy failed. Try again." : ""}</span>
    <button className="block-copy-button" type="button" aria-label={label} onClick={() => void copy()}>
      {status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}<span>Copy</span>
    </button>
  </span>;
}
