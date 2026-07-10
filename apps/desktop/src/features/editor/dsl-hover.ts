import { hoverTooltip } from "@codemirror/view";

import { VERB_DOCS } from "./dsl-docs";

const WORD_RE = /[\w-]/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const dslHoverTooltip = hoverTooltip((view, pos, side) => {
  const { from, to, text } = view.state.doc.lineAt(pos);
  let start = pos;
  let end = pos;
  while (start > from && WORD_RE.test(text[start - from - 1])) start--;
  while (end < to && WORD_RE.test(text[end - from])) end++;
  if (start === end || (start === pos && side < 0)) return null;
  const word = text.slice(start - from, end - from);
  const doc = VERB_DOCS[word];
  if (!doc) return null;
  return {
    pos: start,
    end,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-tooltip-keyword";
      dom.innerHTML = `<div class="kw">${escapeHtml(word)}</div><div class="desc">${escapeHtml(doc.description)}</div><pre class="ex">${escapeHtml(doc.example)}</pre>`;
      return { dom };
    },
  };
});
