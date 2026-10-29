#!/usr/bin/env node
// Builds the Mod Hub site for a central hmod repository.
//   node ci/build-site.mjs --repo <dir> --out <dir>
// The site address comes from repo.json "siteUrl", or from GITHUB_REPOSITORY
// (owner.github.io/name) when run in GitHub Actions.
import fs from 'node:fs';
import path from 'node:path';
import { args, need, loadPackages, readJson } from './lib.mjs';
import { modFromArchive } from '../src/model.js';
import { buildRepoFiles } from '../src/repo.js';
import { pagesUrl, cleanDomain } from '../src/publish.js';
import { parseMeta } from '../src/central.js';

const opts = args();
need(opts, 'repo', 'out');

const config = readJson(path.join(opts.repo, 'repo.json'));
let siteUrl = String(config.siteUrl || '').trim().replace(/\/+$/, '');
if (!siteUrl && process.env.GITHUB_REPOSITORY) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  siteUrl = pagesUrl({ owner, repo });
}
if (!siteUrl) {
  console.error('Set "siteUrl" in repo.json to the address the site is served from.');
  process.exit(2);
}

const mods = [];
const packed = new Map();
for (const [file, entry] of [...loadPackages(opts.repo)].sort(([a], [b]) => a.localeCompare(b))) {
  if (!entry.bytes) continue;
  const mod = await modFromArchive(file, entry.bytes);
  const meta = entry.metaText ? parseMeta(entry.metaText, file).meta : null;
  if (meta && !mod.readme.front.Version) mod.readme.front.Version = meta.version;
  mods.push(mod);
  packed.set(mod.id, entry.bytes); // publish exactly the reviewed bytes
}

const files = (await buildRepoFiles({ title: config.title, readme: config.readme, baseUrl: siteUrl }, mods, packed))
  .filter((f) => f.path !== 'HOSTING.md');
const host = cleanDomain(siteUrl);
if (host && !host.endsWith('.github.io')) files.push({ path: 'CNAME', data: new TextEncoder().encode(host + '\n') });

fs.rmSync(opts.out, { recursive: true, force: true });
for (const f of files) {
  const dest = path.join(opts.out, f.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.data);
}
console.log(`Built ${mods.length} package${mods.length === 1 ? '' : 's'} for ${siteUrl} into ${opts.out}`);
