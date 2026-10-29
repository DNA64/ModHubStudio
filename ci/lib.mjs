// Helpers shared by the central-repository CI scripts.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import SparkMD5 from 'spark-md5';
import { PACKAGES_DIR } from '../src/central.js';
import { kindFromFileName } from '../src/model.js';

// The browser build loads these from a CDN as globals.
globalThis.JSZip = JSZip;
globalThis.SparkMD5 = SparkMD5;

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

export function need(opts, ...keys) {
  const missing = keys.filter((k) => !opts[k]);
  if (missing.length) {
    console.error(`Missing ${missing.map((k) => `--${k}`).join(', ')}`);
    process.exit(2);
  }
}

// packages/ as Map(file -> { bytes, metaText }); a lone .json shows up with bytes: null.
export function loadPackages(root) {
  const dir = path.join(root, PACKAGES_DIR);
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const names = fs.readdirSync(dir);
  for (const name of names) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    if (kindFromFileName(name)) {
      const meta = path.join(dir, `${name}.json`);
      out.set(name, {
        bytes: new Uint8Array(fs.readFileSync(full)),
        metaText: fs.existsSync(meta) ? fs.readFileSync(meta, 'utf8') : null,
      });
    } else if (name.endsWith('.json') && kindFromFileName(name.slice(0, -5)) && !names.includes(name.slice(0, -5))) {
      out.set(name.slice(0, -5), { bytes: null, metaText: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

// Every file under root except .git, as relative paths.
export function listFiles(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out;
}

export function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
