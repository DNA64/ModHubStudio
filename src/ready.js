// "Ready to publish": the author confirms a package's readme on its Readme tab
// before it can be published. Name, Creator, Category and Version must be filled
// in, and at least one console selected; the other standard fields only get a warning.
import { REQUIRED_FIELDS, STANDARD_FIELDS } from './readme.js';
import { resolveTargets } from './targets.js';
import { keepsOriginal, hmodFileName } from './pack.js';

const filled = (mod, k) => !!String(mod.readme.front[k] || '').trim();

// What still has to be filled in: the four readme fields, and at least one console.
export const missingRequired = (mod) => [
  ...REQUIRED_FIELDS.filter((k) => !filled(mod, k)),
  ...(resolveTargets(mod).ids.length ? [] : ['Consoles']),
];
export const missingOptional = (mod) => STANDARD_FIELDS.filter((k) => !REQUIRED_FIELDS.includes(k) && !filled(mod, k));

// A package opened from an existing repository and left unchanged is published
// exactly as it already was, so it doesn't need confirming again. Neither does
// one whose file couldn't be downloaded: it can't be changed.
export const alreadyPublished = (mod) => !!(mod.origin && (mod.unavailable || (keepsOriginal(mod) && hmodFileName(mod) === mod.origin.fileName)));

export function isReady(mod) {
  if (alreadyPublished(mod)) return true;
  return !!mod.ready && missingRequired(mod).length === 0;
}

// Ticking needs every required field; clearing one unticks it.
export function setReady(mod, ready) {
  return { ...mod, ready: !!ready && missingRequired(mod).length === 0 };
}

// "Confirm all complete readmes": ticks every package whose required fields are
// filled in, and leaves the rest for the author to open.
export function confirmComplete(mods) {
  return mods.map((m) => (isReady(m) || missingRequired(m).length ? m : { ...m, ready: true }));
}
