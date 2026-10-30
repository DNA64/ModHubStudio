// Mirrors HmodReadme in hakchi2-CE (hakchi_gui/Hmod/Readme.cs).
const FRONT_RE = /^(?:-{3,}[\r\n]+([\s\S]*?)[\r\n]*-{3,})?[\r\n\t\s]*([\s\S]*)[\r\n\t\s]*$/;
const FIELD_RE = /^[ \t]*([^:\r\n]+?)[ \t]*:[ \t]*(.*?)[ \t]*$/gm;

export const STANDARD_FIELDS = ['Name', 'Creator', 'Maintainer', 'Category', 'Version', 'Emulated System', 'Prerequisite', 'Command Line', 'Tags'];
// Written by this tool from the Consoles setting; not edited as free text.
export const MANAGED_FIELDS = ['Consoles'];
export const REQUIRED_FIELDS = ['Name', 'Creator', 'Category', 'Version'];
export const CATEGORIES = ['UI', 'Theme', 'Music', 'Emulator', 'Core', 'Tweak', 'Utility', 'Font', 'Module'];

export function parseReadme(text) {
  const raw = (text || '').replace(/^﻿/, '');
  const m = raw.match(FRONT_RE);
  const front = {};
  const order = [];
  if (m && m[1] !== undefined) {
    for (const f of m[1].matchAll(FIELD_RE)) {
      if (!(f[1] in front)) { front[f[1]] = f[2]; order.push(f[1]); }
    }
  }
  return {
    front,
    order,
    body: m ? m[2].trim() : raw.trim(),
    hadFrontMatter: !!(m && m[1] !== undefined),
    // CE only reads front matter when '---' is the very first thing in the file.
    frontMatterNotAtTop: !(m && m[1] !== undefined) && /^\s+-{3,}[ \t]*\r?\n[^\n]*:/.test(raw),
  };
}

export function serializeReadme({ front, order, body }) {
  const keys = [...new Set([...STANDARD_FIELDS.filter((k) => front[k]), ...(order || []), ...Object.keys(front)])]
    .filter((k) => front[k] !== undefined && String(front[k]).trim() !== '');
  const lines = keys.map((k) => `${k}: ${String(front[k]).trim()}`);
  const fm = lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
  return `${fm}${(body || '').trim()}\n`;
}
