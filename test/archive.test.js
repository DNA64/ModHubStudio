import { test } from 'node:test';
import assert from 'node:assert/strict';
import SevenZip from '7z-wasm';
import { tgz, zip, unpack, desktop, FULL_README, bytesText, ids } from './helpers.js';
import { is7z, read7z, write7z, readZip, formatFromFileName } from '../src/archive.js';
import { modFromArchive, modsFromPackageFolder, isUnchanged, looksLikePackageFolder } from '../src/model.js';
import { applyAllFixes, validate } from '../src/rules.js';
import { packPackage, serverFileName, hmodFileName, keepsOriginal } from '../src/pack.js';
import { buildRepoFiles } from '../src/repo.js';
import { textBytes } from '../src/tar.js';

globalThis.SevenZip = SevenZip;

const file = (path, text, mode = 0o644) => ({ path, type: 'file', data: textBytes(text), mode });
const sz = (spec) => write7z(Object.entries(spec).map(([p, t]) => file(p, t)));

test('7z archives are written and read back', async () => {
  const bytes = await sz({ 'readme.md': FULL_README, 'usr/share/x/a.txt': 'a' });
  assert.ok(is7z(bytes));
  const back = Object.fromEntries((await read7z(bytes)).filter((e) => e.type === 'file').map((e) => [e.path, bytesText(e.data)]));
  assert.deepEqual(back, { 'readme.md': FULL_README, 'usr/share/x/a.txt': 'a' });
  await assert.rejects(read7z(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]), 'bad.7z'), /bad\.7z/);
});

test('format comes from the file name', () => {
  assert.equal(formatFromFileName('CLV-Z-XASH3D.7z'), '7z');
  assert.equal(formatFromFileName('https://x.net/a/OutRun.ZIP?x=1'), 'zip');
  assert.equal(formatFromFileName('a.hmod'), null);
});

test('a .zip and a .7z open as packages and stay in their format', async () => {
  const z = await zip({ 'readme.md': FULL_README, install: 'return 0\n', 'usr/bin/t': '#!/bin/sh\n' });
  const zm = await modFromArchive('tester.tool.zip', z);
  assert.equal(zm.kind, 'hmod');
  assert.equal(zm.name, 'tester.tool');
  assert.equal(zm.format, 'zip');
  assert.equal(hmodFileName(zm), 'tester.tool.hmod');
  assert.equal(serverFileName(zm), 'tester.tool.zip');
  assert.ok(ids(validate(zm)).includes('format-kept'));
  assert.ok(!ids(validate(zm)).includes('container-zip'));

  const g = await sz({ 'CLV-Z-ABCDE.desktop': desktop('CLV-Z-ABCDE', '/bin/x'), 'CLV-Z-ABCDE/x.bin': 'x' });
  const gm = await modFromArchive('CLV-Z-ABCDE.7z', g);
  assert.equal(gm.kind, 'game');
  assert.equal(gm.format, '7z');
  assert.ok(ids(validate(gm)).includes('game-7z'));
});

test('a ZIP named .hmod is still repacked as tar.gz, as before', async () => {
  const m = await modFromArchive('t.hmod', await zip({ 'readme.md': FULL_README, 'usr/share/x/a': 'a' }));
  assert.equal(m.format, null);
  assert.ok(ids(validate(m)).includes('container-zip'));
  assert.equal(keepsOriginal(m), false);
  const t = await unpack(await packPackage(m));
  assert.ok(t['usr/share/x/a']);
});

test('an unchanged ZIP or 7z is published byte for byte; a changed one is repacked in its format', async () => {
  const z = await zip({ 'readme.md': FULL_README, 'Etc/preinit.d/p8100_x': 'echo', 'usr/share/x/a': 'a' });
  const m = await modFromArchive('tester.x.zip', z);
  assert.ok(isUnchanged(m));
  assert.equal(await packPackage(m), z);
  const fixed = applyAllFixes(m);
  assert.ok(!isUnchanged(fixed));
  const out = await packPackage(fixed);
  assert.notEqual(out, z);
  const files = Object.fromEntries((await readZip(out)).map((e) => [e.path, bytesText(e.data)]));
  assert.equal(files['etc/preinit.d/p8100_x'], 'echo\n');
  assert.ok(files['readme.md'].includes('Name: Test Mod'));

  const s = await sz({ 'readme.md': FULL_README, 'usr/share/x/a': 'a' });
  const sm = await modFromArchive('tester.y.7z', s);
  assert.equal(await packPackage(sm), s);
  const edited = { ...sm, readme: { ...sm.readme, front: { ...sm.readme.front, Version: '2.0.0' } } };
  const back = await read7z(await packPackage(edited));
  assert.ok(bytesText(back.find((e) => e.path === 'readme.md').data).includes('Version: 2.0.0'));
});

test('ZIP and 7z modules are marked for extraction in the repository', async () => {
  const m = await modFromArchive('tester.x.zip', await zip({ 'readme.md': FULL_README, 'usr/share/x/a': 'a' }));
  const g = await modFromArchive('CLV-Z-ABCDE.zip', await zip({ 'CLV-Z-ABCDE.desktop': desktop('CLV-Z-ABCDE', '/bin/x') }));
  const packed = new Map([[m.id, await packPackage(m)], [g.id, await packPackage(g)]]);
  const files = Object.fromEntries((await buildRepoFiles({ baseUrl: 'https://me.github.io/r' }, [m, g], packed)).map((f) => [f.path, f.data]));
  assert.ok(files['hmods/tester.x.zip']);
  assert.ok(files['games/CLV-Z-ABCDE.zip']);
  assert.ok(files['.repo/tester.x.hmod/extract']);
  assert.ok(!files['.repo/CLV-Z-ABCDE.clvg/extract'], 'games are opened by Hakchi2 CE, not extracted');
  assert.equal(bytesText(files['.repo/tester.x.hmod/link']).trim(), 'https://me.github.io/r/hmods/tester.x.zip');
  assert.equal(bytesText(files['.repo/list']), 'tester.x.hmod\nCLV-Z-ABCDE.clvg\n');
});

test('a folder of packages picks up top-level .zip and .7z files only', async () => {
  const z = await zip({ 'readme.md': FULL_README, 'usr/share/x/a': 'a' });
  const s = await sz({ 'CLV-Z-ABCDE.desktop': desktop('CLV-Z-ABCDE', '/bin/x') });
  const r = await modsFromPackageFolder([
    { path: 'a.zip', data: z }, { path: 'CLV-Z-ABCDE.7z', data: s }, { path: 'deep/inner.zip', data: z },
  ]);
  assert.deepEqual(r.mods.map((m) => `${m.name}:${m.format}`).sort(), ['CLV-Z-ABCDE:7z', 'a:zip']);
  assert.deepEqual(r.skipped, ['deep/inner.zip']);
  assert.equal(looksLikePackageFolder([{ path: 'usr/share/x/assets.zip', data: z }, { path: 'readme.md', data: textBytes('x') }]), false,
    'a mod that ships a ZIP of its own is still one mod');
});

test('an archive holding only a 7z is unwrapped', async () => {
  const inner = await sz({ 'readme.md': FULL_README, 'usr/share/x/a': 'a' });
  const m = await modFromArchive('t.hmod', await tgz({ 't.7z': inner }));
  assert.ok(m.files.some((f) => f.path === 'usr/share/x/a'));
});
