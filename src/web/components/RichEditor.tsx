import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, CheckSquare, Highlighter, Link2, List, ListOrdered, Pilcrow, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RichTextDocument } from "../../domain/types";

interface Props {
  value: RichTextDocument;
  onChange: (value: RichTextDocument) => void;
  compact?: boolean;
  placeholder?: string;
}

export function RichEditor({ value, onChange, compact = false, placeholder }: Props) {
  const [showStructure, setShowStructure] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      Highlight,
      TaskList,
      TaskItem.configure({ nested: false }),
    ],
    content: value,
    editorProps: { attributes: { class: `rich-input${compact ? " compact" : ""}`, "data-placeholder": placeholder ?? "Write…" } },
    onUpdate: ({ editor: current }) => onChange(current.getJSON() as RichTextDocument),
  });

  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(value)) editor.commands.setContent(value);
  }, [editor, value]);

  if (!editor) return null;
  const setLink = () => {
    const current = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("Link address", current ?? "https://");
    if (href === null) return;
    if (!href.trim()) editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  };

  return <div className="editor-shell">
    <EditorContent editor={editor} />
    <div className="format-bar" aria-label="Formatting">
      <button type="button" className={showStructure ? "active" : ""} onClick={() => setShowStructure(!showStructure)} aria-label="Structure options">{showStructure ? <X /> : <Plus />}</button>
      {showStructure && <>
        <button type="button" className={editor.isActive("heading") ? "active" : ""} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} aria-label="Section heading"><Pilcrow /></button>
        <button type="button" className={editor.isActive("bulletList") ? "active" : ""} onClick={() => editor.chain().focus().toggleBulletList().run()} aria-label="Bullet list"><List /></button>
        <button type="button" className={editor.isActive("orderedList") ? "active" : ""} onClick={() => editor.chain().focus().toggleOrderedList().run()} aria-label="Numbered list"><ListOrdered /></button>
        <button type="button" className={editor.isActive("taskList") ? "active" : ""} onClick={() => editor.chain().focus().toggleTaskList().run()} aria-label="Checklist"><CheckSquare /></button>
      </>}
      <span />
      <button type="button" className={editor.isActive("bold") ? "active" : ""} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold"><Bold /></button>
      <button type="button" className={editor.isActive("highlight") ? "active" : ""} onClick={() => editor.chain().focus().toggleHighlight().run()} aria-label="Highlight"><Highlighter /></button>
      <button type="button" className={editor.isActive("link") ? "active" : ""} onClick={setLink} aria-label="Link"><Link2 /></button>
    </div>
  </div>;
}

export function RichView({ document }: { document: RichTextDocument }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [3] } }), Link, Highlight, TaskList, TaskItem],
    content: document,
    editable: false,
    editorProps: { attributes: { class: "rich-view" } },
  });
  useEffect(() => {
    if (editor) editor.commands.setContent(document);
  }, [document, editor]);
  return <EditorContent editor={editor} />;
}
