import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import SevenZip from '7z-wasm';
import { tgz, zip, desktop, readme, bytesText, textBytes, ids } from './helpers.js';
import { buildTar, gzip, gunzip, parseTar } from '../src/tar.js';
import { importRepository, parseRepoPack, readRepositoryIndex, siteFromFiles, siteFromAddress, guessBase, attachFile } from '../src/import.js';
import { applyAllFixes, validate } from '../src/rules.js';
import { packPackage, hmodFileName } from '../src/pack.js';
import { buildRepoFiles, repoIssues, packagePlacement, siteFolders, defaultFolder, staleFiles } from '../src/repo.js';
import { modFromArchive, isUnchanged } from '../src/model.js';

globalThis.SevenZip = SevenZip;

const md5 = (u8) => crypto.createHash('md5').update(u8).digest('hex');
const sha1 = (u8) => crypto.createHash('sha1').update(u8).digest('hex');
const BASE = 'https://classic.example';

// A site laid out like classicmods.net: packages under /nimbus/..., details
// only inside pack.tgz, hashes in upper case with Windows line endings.
async function site() {
  const files = {
    'nimbus/Mods/silent_cursor.hmod': await tgz({ 'readme.md': readme({ Name: 'Silent_Cursor', Version: '01-11-17', Creator: 'viral_dna' }), 'usr/share/ui/snes-usa/a.wav': 'x' }),
    'nimbus/Mods/boothome.hmod': await tgz({ 'readme.md': readme({ Name: 'Boot Home' }), 'etc/preinit.d/p8100_boothome': 'echo home\n' }),
    'nimbus/Hakchi_Packaged_Cores/CORE_fceumm.hmod': await tgz({ 'readme.md': readme({ Name: 'fceumm', Category: 'Core' }), 'etc/libretro/core/fceumm_libretro.so': 'so' }),
    'nimbus/Ports/Nintendo/CLV-Z-OUTRUN.zip': await zip({ 'CLV-Z-OUTRUN.desktop': desktop('CLV-Z-OUTRUN', '/bin/outrun', 'OutRun'), 'CLV-Z-OUTRUN/outrun.bin': 'x' }),
  };
  const links = {
    'silent_cursor.hmod': `${BASE}/nimbus/Mods/silent_cursor.hmod`,
    'boothome.hmod': `${BASE}/nimbus/Mods/boothome.hmod`,
    'CORE_fceumm.hmod': `${BASE}/nimbus/Hakchi_Packaged_Cores/CORE_fceumm.hmod`,
    'CLV-Z-OUTRUN.clvg': `${BASE}/nimbus/Ports/Nintendo/CLV-Z-OUTRUN.zip`,
    'CLV-Z-XASH.clvg': 'https://cloud.example/Ports/CLV-Z-XASH.7z ',
  };
  const fileFor = (name) => files[links[name].trim().slice(BASE.length + 1)];
  const entries = [
    { path: 'list', data: 'silent_cursor.hmod\r\nboothome.hmod\r\nsilent_cursor.hmod\r\nCORE_fceumm.hmod\r\nCLV-Z-OUTRUN.clvg\r\nCLV-Z-XASH.clvg\r\n' },
    { path: 'readme.md', data: 'Welcome to the test repository!' },
  ];
  for (const [name, link] of Object.entries(links)) {
    entries.push({ path: `${name}/`, type: 'dir' });
    entries.push({ path: `${name}/link`, data: link });
    const f = fileFor(name);
    entries.push({ path: `${name}/md5`, data: f ? md5(f).toUpperCase() + '\r\n' : 'ABC\r\n' });
    entries.push({ path: `${name}/sha1`, data: f ? sha1(f) + '\r\n' : 'abc\r\n' });
    entries.push({ path: `${name}/readme.md`, data: name.startsWith('CLV') ? `---\nName: ${name} listing\nCategory: Ports\n---\nPlay it.\n` : `listing for ${name}` });
  }
  entries.push({ path: 'orphan.hmod/link', data: `${BASE}/nimbus/Mods/orphan.hmod` });
  const pack = await gzip(buildTar(entries.map((e) => (e.type === 'dir'
    ? { path: e.path.slice(0, -1), type: 'dir', mode: 0o777 }
    : { path: e.path, type: 'file', data: textBytes(e.data), mode: 0o777 }))));
  return { files: { ...files, '.repo/pack.tgz': pack, '.repo/readme.md': textBytes('Welcome to the test repository!') }, links };
}

const fakeFetch = (files) => async (url) => {
  if (!url.startsWith(BASE + '/')) throw new TypeError('Failed to fetch');
  const f = files[decodeURIComponent(url.slice(BASE.length + 1))];
  return f ? new Response(f, { status: 200 }) : new Response('nope', { status: 404 });
};

async function openByAddress() {
  const { files } = await site();
  const s = siteFromAddress(BASE + '/', fakeFetch(files));
  return { files, result: await importRepository({ base: s.base, readFile: s.readFile, download: s.download }) };
}

test('pack.tgz is read the way Hakchi2 CE reads it', async () => {
  const { files } = await site();
  const r = await parseRepoPack(files['.repo/pack.tgz']);
  assert.deepEqual(r.items.map((i) => i.fileName), ['silent_cursor.hmod', 'boothome.hmod', 'CORE_fceumm.hmod', 'CLV-Z-OUTRUN.clvg', 'CLV-Z-XASH.clvg']);
  assert.equal(r.items[3].link, `${BASE}/nimbus/Ports/Nintendo/CLV-Z-OUTRUN.zip`);
  assert.equal(r.items[4].link, 'https://cloud.example/Ports/CLV-Z-XASH.7z', 'whitespace around links is trimmed, as Hakchi2 CE does');
  assert.equal(r.readme, 'Welcome to the test repository!');
  const texts = r.problems.map((p) => p.text).join(' ');
  assert.match(texts, /silent_cursor\.hmod is listed twice/);
  assert.match(texts, /orphan\.hmod has details .* isn't in its list/);
});

test('loose .repo files are read when there is no pack.tgz', async () => {
  const files = {
    '.repo/list': textBytes('a.hmod\nmissing.hmod\n'),
    '.repo/a.hmod/link': textBytes('https://x.example/hmods/a.hmod\n'),
    '.repo/a.hmod/md5': textBytes('0123\n'),
    '.repo/a.hmod/readme.txt': textBytes('plain readme'),
    '.repo/a.hmod/extract': new Uint8Array(0),
  };
  const r = await readRepositoryIndex(async (p) => files[p] || null);
  assert.equal(r.from, 'list');
  assert.deepEqual(r.items, [{ fileName: 'a.hmod', link: 'https://x.example/hmods/a.hmod', md5: '0123', readme: 'plain readme', readmeName: 'readme.txt', extract: true }]);
  assert.match(r.problems[0].text, /missing\.hmod is listed, but/);
  await assert.rejects(readRepositoryIndex(async () => null), /isn't a Mod Hub repository/);
});

test('opening by address downloads each package, checks it and keeps its origin', async () => {
  const { result } = await openByAddress();
  const byName = Object.fromEntries(result.mods.map((m) => [m.origin.fileName, m]));
  assert.equal(result.mods.length, 5);
  assert.equal(result.repo.baseUrl, BASE);
  assert.equal(result.repo.readme, 'Welcome to the test repository!');
  assert.equal(result.repo.imported.packages.length, 5);

  const sc = byName['silent_cursor.hmod'];
  assert.equal(sc.kind, 'hmod');
  assert.equal(sc.readme.front.Version, '01-11-17', 'a mod keeps the readme inside its package');
  assert.ok(isUnchanged(sc));
  assert.equal(sc.origin.md5, md5(await packPackage(sc)).toUpperCase(), 'upper-case hashes still match');

  const game = byName['CLV-Z-OUTRUN.clvg'];
  assert.equal(game.kind, 'game');
  assert.equal(game.format, 'zip');
  assert.equal(game.readme.front.Name, 'CLV-Z-OUTRUN.clvg listing', 'a game takes its listing from the repository');

  const xash = byName['CLV-Z-XASH.clvg'];
  assert.match(xash.unavailable, /doesn't let other websites read/);
  assert.deepEqual(ids(validate(xash)), ['unavailable']);
  assert.ok(result.problems.some((p) => /CLV-Z-XASH\.clvg/.test(p.text)));
  assert.ok(!result.problems.some((p) => /md5/.test(p.text)), 'every downloaded file matched its hashes');
});

test('a blocked site says how to open it instead', async () => {
  const s = siteFromAddress('https://blocked.example', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(importRepository({ base: s.base, readFile: s.readFile, download: s.download }), /Access-Control-Allow-Origin.*Open a copy of the site/);
});

test('a mismatched hash is reported, not hidden', async () => {
  const { files } = await site();
  files['nimbus/Mods/boothome.hmod'] = await tgz({ 'readme.md': readme({ Name: 'Replaced' }), 'etc/x': 'y' });
  const s = siteFromAddress(BASE, fakeFetch(files));
  const r = await importRepository({ base: s.base, readFile: s.readFile, download: s.download });
  assert.ok(r.problems.some((p) => /boothome\.hmod: the downloaded file doesn't match the repository's md5/.test(p.text)));
});

test('publishing an untouched repository changes nothing but .repo', async () => {
  const { result } = await openByAddress();
  const repo = { ...result.repo, hosting: 'own' };
  const packed = new Map();
  for (const m of result.mods) if (!m.unavailable) packed.set(m.id, await packPackage(m));
  const files = await buildRepoFiles(repo, result.mods, packed);
  const paths = files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith('nimbus/') || p.startsWith('hmods/') || p.startsWith('games/')), 'no package files to upload');
  assert.ok(!paths.includes('index.html') && !paths.includes('.nojekyll'), "the site's own pages are left alone");
  assert.ok(paths.includes('UPLOAD.md'));

  const out = Object.fromEntries(files.map((f) => [f.path, f.data]));
  assert.equal(bytesText(out['.repo/list']), 'silent_cursor.hmod\nboothome.hmod\nCORE_fceumm.hmod\nCLV-Z-OUTRUN.clvg\nCLV-Z-XASH.clvg\n');
  const { files: orig } = await site();
  const before = await parseRepoPack(orig['.repo/pack.tgz']);
  const after = await parseRepoPack(out['.repo/pack.tgz']);
  for (const item of before.items) {
    const a = after.items.find((i) => i.fileName === item.fileName);
    assert.equal(a.link, item.link, item.fileName);
    assert.equal(a.md5, item.md5, item.fileName);
    assert.equal(a.sha1, item.sha1, item.fileName);
    assert.equal(a.readme, item.readme, item.fileName);
  }
  assert.equal(after.readme.trim(), before.readme.trim());
  assert.equal(repoIssues(repo, result.mods).filter((i) => i.severity === 'error').length, 0);
});

test('a changed package goes back to its own path with new hashes', async () => {
  const { result } = await openByAddress();
  const repo = { ...result.repo };
  const boot = result.mods.find((m) => m.origin.fileName === 'boothome.hmod');
  const edited = { ...boot, readme: { ...boot.readme, front: { ...boot.readme.front, Version: '1.1' } } };
  const mods = result.mods.map((m) => (m.id === boot.id ? edited : m));
  const packed = new Map();
  for (const m of mods) if (!m.unavailable) packed.set(m.id, await packPackage(m));
  const out = Object.fromEntries((await buildRepoFiles(repo, mods, packed)).map((f) => [f.path, f.data]));
  const bytes = out['nimbus/Mods/boothome.hmod'];
  assert.ok(bytes, 'uploaded to its original path');
  assert.equal(Object.keys(out).filter((p) => p.startsWith('nimbus/')).length, 1, 'only the changed package is in the download');
  assert.equal(bytesText(out['.repo/boothome.hmod/link']).trim(), `${BASE}/nimbus/Mods/boothome.hmod`);
  assert.equal(bytesText(out['.repo/boothome.hmod/md5']).trim(), md5(bytes));
  assert.match(bytesText(out['.repo/boothome.hmod/readme.md']), /Version: 1\.1/);
  assert.match(bytesText(out['UPLOAD.md']), /`nimbus\/Mods\/boothome\.hmod`/);
});

test('a fix that only rewrites the readme counts as a change', async () => {
  const { files } = await site();
  files['nimbus/Mods/boothome.hmod'] = await tgz({ 'readme.md': '\n' + readme({ Name: 'Boot Home' }), 'etc/preinit.d/p8100_boothome': 'echo home\n' });
  const s = siteFromAddress(BASE, fakeFetch(files));
  const r = await importRepository({ base: s.base, readFile: s.readFile, download: s.download });
  const boot = r.mods.find((m) => m.origin.fileName === 'boothome.hmod');
  assert.ok(ids(validate(boot)).includes('readme-top'));
  const fixed = applyAllFixes(boot);
  assert.ok(isUnchanged(boot) && !isUnchanged(fixed));
});

test('a changed ZIP game stays a ZIP at its link', async () => {
  const { result } = await openByAddress();
  const game = result.mods.find((m) => m.origin.fileName === 'CLV-Z-OUTRUN.clvg');
  const edited = { ...game, files: game.files.map((f) => (f.path.endsWith('.bin') ? { ...f, data: textBytes('y') } : f)) };
  const mods = result.mods.map((m) => (m.id === game.id ? edited : m));
  const packed = new Map([[edited.id, await packPackage(edited)]]);
  const out = Object.fromEntries((await buildRepoFiles(result.repo, mods, packed)).map((f) => [f.path, f.data]));
  const z = out['nimbus/Ports/Nintendo/CLV-Z-OUTRUN.zip'];
  assert.ok(z && z[0] === 0x50 && z[1] === 0x4b);
  assert.equal(bytesText(out['.repo/CLV-Z-OUTRUN.clvg/link']).trim(), `${BASE}/nimbus/Ports/Nintendo/CLV-Z-OUTRUN.zip`);
});

test('new packages go into a folder the site already has, chosen by the author', async () => {
  const { result } = await openByAddress();
  const repo = result.repo;
  const folders = siteFolders(repo, result.mods);
  assert.deepEqual(folders.map((f) => f.folder), ['nimbus/Mods', 'nimbus/Hakchi_Packaged_Cores', 'nimbus/Ports/Nintendo']);

  const mod = await modFromArchive('tester.new.hmod', await tgz({ 'readme.md': readme({ Name: 'New', Version: '1' }), 'etc/x': 'y' }));
  const game = await modFromArchive('CLV-Z-NEWGM.zip', await zip({ 'CLV-Z-NEWGM.desktop': desktop('CLV-Z-NEWGM', '/bin/x') }));
  assert.equal(defaultFolder(repo, mod), 'nimbus/Mods');
  assert.equal(defaultFolder(repo, game), 'nimbus/Ports/Nintendo');
  assert.equal(packagePlacement(repo, mod).link, `${BASE}/nimbus/Mods/tester.new.hmod`);

  const picked = { ...mod, folder: 'nimbus/Hakchi_Packaged_Cores' };
  const mods = [...result.mods, picked, game];
  const packed = new Map([[picked.id, await packPackage(picked)], [game.id, await packPackage(game)]]);
  const out = Object.fromEntries((await buildRepoFiles(repo, mods, packed)).map((f) => [f.path, f.data]));
  assert.ok(out['nimbus/Hakchi_Packaged_Cores/tester.new.hmod']);
  assert.ok(out['nimbus/Ports/Nintendo/CLV-Z-NEWGM.zip']);
  assert.ok(!Object.keys(out).some((p) => p.startsWith('hmods/') || p.startsWith('games/')), 'no new folders');
  assert.equal(bytesText(out['.repo/CLV-Z-NEWGM.clvg/link']).trim(), `${BASE}/nimbus/Ports/Nintendo/CLV-Z-NEWGM.zip`);
});

test('removed and renamed packages are listed for deletion', async () => {
  const { result } = await openByAddress();
  const repo = result.repo;
  const boot = result.mods.find((m) => m.origin.fileName === 'boothome.hmod');
  const mods = result.mods.filter((m) => m.origin.fileName !== 'silent_cursor.hmod').map((m) => (m.id === boot.id ? { ...m, name: 'tester.boothome' } : m));
  assert.equal(hmodFileName(mods.find((m) => m.id === boot.id)), 'tester.boothome.hmod');
  assert.equal(packagePlacement(repo, mods.find((m) => m.id === boot.id)).path, 'nimbus/Mods/tester.boothome.hmod', 'a renamed package stays in its folder');
  assert.deepEqual(staleFiles(repo, mods).sort(), ['nimbus/Mods/boothome.hmod', 'nimbus/Mods/silent_cursor.hmod']);
  const packed = new Map([[boot.id, await packPackage(mods.find((m) => m.id === boot.id))]]);
  const guide = bytesText(Object.fromEntries((await buildRepoFiles(repo, mods, packed)).map((f) => [f.path, f.data]))['UPLOAD.md']);
  assert.match(guide, /Can be deleted[\s\S]*nimbus\/Mods\/silent_cursor\.hmod[\s\S]*\.repo\/silent_cursor\.hmod\//);
});

test('a package from another host that changed is flagged and kept apart', async () => {
  const { result } = await openByAddress();
  const xash = result.mods.find((m) => m.origin.fileName === 'CLV-Z-XASH.clvg');
  const zipped = await zip({ 'CLV-Z-XASH.desktop': desktop('CLV-Z-XASH', '/bin/x'), 'CLV-Z-XASH/a': 'a' });
  const { mod: got, problems } = await attachFile(xash, zipped);
  assert.equal(got.id, xash.id);
  assert.ok(!got.unavailable);
  assert.ok(problems.some((p) => /md5/.test(p.text)), 'the chosen file is checked against the repository too');
  const edited = { ...got, readme: { ...got.readme, front: { ...got.readme.front, Version: '2' } } };
  const mods = result.mods.map((m) => (m.id === xash.id ? edited : m));
  assert.ok(repoIssues(result.repo, mods).some((i) => /cloud\.example/.test(i.text)));
  const packed = new Map([[edited.id, await packPackage(edited)]]);
  const out = Object.fromEntries((await buildRepoFiles(result.repo, mods, packed)).map((f) => [f.path, f.data]));
  assert.ok(out['other-hosts/cloud.example/Ports/CLV-Z-XASH.7z']);
  assert.match(bytesText(out['UPLOAD.md']), /other-hosts\/cloud\.example\/Ports\/CLV-Z-XASH\.7z.*→ https:\/\/cloud\.example\/Ports\/CLV-Z-XASH\.7z/);
});

test('a copy of the site is opened from its folder, wherever .repo sits', async () => {
  const { files } = await site();
  const list = Object.entries(files).map(([p, d]) => ({ path: `classic.example/${p}`, data: d }));
  const s = siteFromFiles(list);
  const index = await readRepositoryIndex(s.readFile);
  const base = guessBase(index.items.map((i) => i.link), s.match);
  assert.equal(base, BASE);
  const r = await importRepository({ base, readFile: s.readFile, localFile: s.localFile });
  assert.equal(r.mods.filter((m) => !m.unavailable).length, 4);
  assert.match(r.mods.find((m) => m.origin.fileName === 'CLV-Z-XASH.clvg').unavailable, /isn't in the chosen folder/);

  // Just the .repo folder: everything is listed, nothing downloaded.
  const only = siteFromFiles([{ path: '.repo/pack.tgz', data: files['.repo/pack.tgz'] }]);
  const r2 = await importRepository({ base: BASE, readFile: only.readFile, localFile: only.localFile });
  assert.equal(r2.mods.length, 5);
  assert.ok(r2.mods.every((m) => m.unavailable));
  assert.throws(() => siteFromFiles([{ path: 'x/readme.md', data: textBytes('') }]), /isn't a copy of a Mod Hub repository/);
});

test('a site address with odd characters in links still matches the copy', async () => {
  const s = siteFromFiles([
    { path: '.repo/list', data: textBytes('a.hmod\n') },
    { path: 'my mods/a.hmod', data: new Uint8Array([1]) },
  ]);
  assert.equal(guessBase(['https://h.example/sub/my%20mods/a.hmod'], s.match), 'https://h.example/sub');
  assert.ok(await s.localFile('https://h.example/sub/my%20mods/a.hmod'));
});
