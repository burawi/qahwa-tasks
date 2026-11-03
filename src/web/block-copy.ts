import type { Element, ElementContent } from "hast";

const blockTags = new Set(["p", "blockquote", "pre", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td"]);

/** Read the Markdown tree, before UI controls or file previews are inserted. */
export function blockCopyText(node: Element | ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  if (node.tagName === "br") return "\n";
  if (node.tagName === "img") return String(node.properties.alt ?? "");
  if (node.tagName === "pre" || node.tagName === "code") {
    return node.children.map(blockCopyText).join("");
  }
  const blocks = node.children.some(child => child.type === "element" && blockTags.has(child.tagName));
  if (!blocks) return node.children.map((child, index) => {
    const previous = node.children[index - 1];
    const text = blockCopyText(child);
    // Markdown hard breaks include both a <br> and a following source newline.
    return previous?.type === "element" && previous.tagName === "br" ? text.replace(/^\n/, "") : text;
  }).join("");
  const separator = node.tagName === "tr" ? "\t" : ["ul", "ol", "table", "thead", "tbody"].includes(node.tagName) ? "\n" : "\n\n";
  return node.children.filter(child => child.type !== "text" || child.value.trim())
    .map(blockCopyText).reduce((text, part, index) => {
      if (index === 0) return part;
      // Code already ends with a newline. Retain it without adding an extra
      // blank line when joining the surrounding quote paragraphs.
      const boundary = separator === "\t" ? separator : "\n".repeat(Math.max(0,
        separator.length - (text.match(/\n*$/)?.[0].length ?? 0) - (part.match(/^\n*/)?.[0].length ?? 0)));
      return text + boundary + part;
    }, "");
}
