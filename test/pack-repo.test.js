import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { tgz, zip, unpack, desktop, FULL_README, bytesText } from './helpers.js';
import { gunzip, parseTar } from '../src/tar.js';
import { modFromArchive } from '../src/model.js';
import { applyAllFixes, validate } from '../src/rules.js';
import { packHmod, hmodFileName } from '../src/pack.js';
import { buildRepoFiles, buildRepoZip, repoIssues, modLink, normalizeBase } from '../src/repo.js';

const hash = (alg, u8) => crypto.createHash(alg).update(u8).digest('hex');

async function sampleMods() {
  const theme = applyAllFixes(await modFromArchive('Night Sky.hmod', await zip({
    'NightSky/readme.md': FULL_README,
    'NightSky/usr/share/ui/snes-usa/resources/bg.png': 'png',
    'NightSky/etc/preinit.d/p8100_sky': 'echo sky',
  })));
  const tool = await modFromArchive('tool.hmod', await tgz({
    'readme.md': FULL_README,
    install: 'return 0\n',
    'usr/bin/tool': { data: '#!/bin/sh\n', mode: 0o644 },
  }));
  const game = await modFromArchive('CLV-H-ABCDE - Test Game.clvg', await tgz({
    'CLV-H-ABCDE.desktop': desktop('CLV-H-ABCDE', '/bin/clover-kachikachi-wr /var/games/CLV-H-ABCDE/x.nes'),
    'CLV-H-ABCDE/x.nes': new Uint8Array(16),
  }));
  return [theme, tool, game];
}

test('packed hmods are root-owned tar.gz with hakchi-style modes', async () => {
  const [theme, tool] = await sampleMods();
  assert.equal(hmodFileName(theme), 'Night_Sky.hmod');
  const t = await unpack(await packHmod(theme));
  assert.ok(t['readme.md'], 'readme is generated at the root');
  assert.ok(t['usr/share/ui/snes-usa/resources/bg.png']);
  assert.equal(t['etc/preinit.d/p8100_sky'].text, 'echo sky\n', 'fix added the trailing newline');
  assert.equal(t['etc/preinit.d/p8100_sky'].mode, 0o644);
  assert.equal(t['usr/'].type, 'dir');

  const u = await unpack(await packHmod(tool));
  assert.equal(u['usr/bin/tool'].mode, 0o755, 'usr/bin is made executable');
  assert.equal(Object.keys(u)[0], 'install', 'control scripts come first');

  const raw = parseTar(await gunzip(await packHmod(tool)));
  assert.ok(raw.every((e) => !e.path.startsWith('/') && !e.path.startsWith('./')));
});

test('a packed hmod reads back clean', async () => {
  const [theme] = await sampleMods();
  const again = await modFromArchive('Night_Sky.hmod', await packHmod(theme));
  assert.deepEqual(validate(again).filter((i) => i.severity === 'error'), []);
  assert.equal(again.readme.front.Name, 'Test Mod');
});

test('packed games keep the .clvg layout and get no readme', async () => {
  const [, , game] = await sampleMods();
  assert.equal(hmodFileName(game), 'CLV-H-ABCDE - Test Game.clvg');
  const g = await unpack(await packHmod(game));
  assert.deepEqual(Object.keys(g).sort(), ['CLV-H-ABCDE.desktop', 'CLV-H-ABCDE/', 'CLV-H-ABCDE/x.nes']);
});

test('repository addresses are checked', () => {
  assert.equal(normalizeBase('https://me.github.io/hmods/.repo/'), 'https://me.github.io/hmods');
  const msgs = (url) => repoIssues({ baseUrl: url }, [{ name: 'a', kind: 'hmod', readme: { front: {} } }]).map((i) => i.severity);
  assert.deepEqual(msgs('https://me.github.io/hmods'), []);
  assert.ok(msgs('').includes('error'));
  assert.ok(msgs('ftp://x').includes('error'));
  assert.ok(msgs('https://github.com/me/hmods').includes('error'));
  assert.ok(msgs('http://me.example').includes('warning'));
});

test('the repository has everything Hakchi2 CE and the console read', async () => {
  const mods = await sampleMods();
  const packed = new Map();
  for (const m of mods) packed.set(m.id, await packHmod(m));
  const repo = { baseUrl: 'https://me.github.io/hmods', title: 'Test', readme: '# Test' };
  const files = Object.fromEntries((await buildRepoFiles(repo, mods, packed)).map((f) => [f.path, f.data]));

  for (const p of ['.repo/pack.tgz', '.repo/list', '.repo/readme.md', '.nojekyll', 'index.html', 'HOSTING.md',
    'hmods/Night_Sky.hmod', 'hmods/tool.hmod', 'games/CLV-H-ABCDE - Test Game.clvg']) assert.ok(files[p], p);

  assert.equal(bytesText(files['.repo/list']), 'Night_Sky.hmod\ntool.hmod\nCLV-H-ABCDE - Test Game.clvg\n');
  assert.equal(bytesText(files['.repo/Night_Sky.hmod/link']).trim(), 'https://me.github.io/hmods/hmods/Night_Sky.hmod');
  assert.equal(bytesText(files['.repo/CLV-H-ABCDE - Test Game.clvg/link']).trim(), 'https://me.github.io/hmods/games/CLV-H-ABCDE%20-%20Test%20Game.clvg');

  const hmod = files['hmods/Night_Sky.hmod'];
  assert.equal(bytesText(files['.repo/Night_Sky.hmod/md5']).trim(), hash('md5', hmod));
  assert.equal(bytesText(files['.repo/Night_Sky.hmod/sha1']).trim(), hash('sha1', hmod));

  // The same patterns ModHub/Repository/Repository.cs uses to read pack.tgz.
  const entries = parseTar(await gunzip(files['.repo/pack.tgz'])).map((e) => e.path);
  assert.ok(entries.some((p) => /^(?:\.\/)?list$/i.test(p)));
  assert.ok(entries.some((p) => /^(?:\.\/)?readme.md$/i.test(p)));
  const meta = entries.filter((p) => /^(?:\.\/)?([^/]+)\/(extract|link|md5|sha1|readme(?:\.(?:md|txt)?)?)$/i.test(p));
  assert.equal(meta.length, mods.length * 4);
});

test('a repository with no packages is valid and empty', async () => {
  assert.ok(!repoIssues({ baseUrl: 'https://x.io' }, []).some((i) => i.severity === 'error'));
  const files = Object.fromEntries((await buildRepoFiles({ baseUrl: 'https://x.io' }, [], new Map())).map((f) => [f.path, f.data]));
  assert.equal(bytesText(files['.repo/list']), '');
  const entries = parseTar(await gunzip(files['.repo/pack.tgz'])).map((e) => e.path);
  assert.deepEqual(entries.sort(), ['list', 'readme.md']);
  assert.ok(!Object.keys(files).some((p) => /^(hmods|games)\//.test(p)));
});

test('an external download link replaces the hosted copy', async () => {
  const [theme] = await sampleMods();
  const ext = { ...theme, externalUrl: 'https://github.com/me/sky/releases/download/v1/Night_Sky.hmod' };
  assert.equal(modLink({ baseUrl: 'https://x.io' }, ext), ext.externalUrl);
  const files = (await buildRepoFiles({ baseUrl: 'https://x.io' }, [ext], new Map([[ext.id, await packHmod(ext)]]))).map((f) => f.path);
  assert.ok(!files.includes('hmods/Night_Sky.hmod'));
});

test('the repository zip unpacks to the same files', async () => {
  const mods = await sampleMods();
  const packed = new Map();
  for (const m of mods) packed.set(m.id, await packHmod(m));
  const z = await JSZip.loadAsync(await buildRepoZip({ baseUrl: 'https://x.io' }, mods, packed));
  assert.ok(z.file('.repo/pack.tgz'));
  assert.ok(z.file('hmods/tool.hmod'));
});
