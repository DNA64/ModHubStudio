import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, zip, folder, desktop, FULL_README, textBytes } from './helpers.js';
import { gzip, gunzip } from '../src/tar.js';
import {
  modFromArchive, modFromFolder, modsFromPackageFolder, looksLikePackageFolder,
  detectKind, setKind, renameFile,
} from '../src/model.js';
import { validate } from '../src/rules.js';

const MOD = { 'readme.md': FULL_README, uninstall: 'rm -f x\n', 'etc/preinit.d/p8000_x': 'echo x\n' };
const GAME = { 'CLV-H-ABCDE.desktop': desktop('CLV-H-ABCDE', '/bin/clover-kachikachi-wr /var/games/CLV-H-ABCDE/game.nes'), 'CLV-H-ABCDE/game.nes': new Uint8Array(16) };

test('only .hmod and .clvg files are accepted', async () => {
  await assert.rejects(modFromArchive('thing.zip', await tgz(MOD)), /\.hmod or \.clvg/);
  await assert.rejects(modFromArchive('thing.tar.gz', await tgz(MOD)), /\.hmod or \.clvg/);
  await assert.rejects(modFromArchive('broken.hmod', textBytes('not an archive')), /tar\.gz/);
});

test('an archive nested inside the package is opened instead of flagged', async () => {
  const innerTar = await gunzip(await tgz(MOD));
  const cases = {
    'zip holding the tar': await zip({ test_mod: innerTar }),
    'gzip of a gzip': await gzip(await tgz(MOD)),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    const m = await modFromArchive('test_mod.hmod', bytes);
    assert.deepEqual(m.files.map((f) => f.path).sort(), ['etc/preinit.d/p8000_x', 'uninstall'], label);
    const found = validate(m).map((i) => i.id);
    assert.ok(found.includes('nested-archive'), label);
    assert.ok(!found.includes('loose-root'), `${label}: the inner archive is not a loose file`);
  }
});

test('a folder holding the extracted tar, or a same-name subfolder, is unwrapped', async () => {
  const innerTar = await gunzip(await tgz(MOD));
  const a = await modFromFolder('test_mod', [{ path: 'test_mod', data: innerTar }]);
  assert.equal(a.files.length, 2);
  const b = await modFromFolder('test_mod', folder({ 'test_mod/readme.md': FULL_README, 'test_mod/etc/preinit.d/p8000_x': 'echo\n' }));
  assert.deepEqual(b.files.map((f) => f.path), ['etc/preinit.d/p8000_x']);
  assert.equal(b.readme.front.Name, 'Test Mod');
});

test('mod or game is decided by contents, then name', async () => {
  assert.equal(detectKind(Object.keys(GAME).map((path) => ({ path, type: 'file' }))).kind, 'game');
  assert.equal(detectKind(Object.keys(MOD).map((path) => ({ path, type: 'file' }))).kind, 'hmod');
  assert.equal(detectKind([{ path: 'something.bin', type: 'file' }]), null);

  const renamedGame = await modFromArchive('oops.hmod', await tgz(GAME));
  assert.equal(renamedGame.kind, 'game');
  assert.ok(validate(renamedGame).some((i) => i.id === 'kind-mismatch'));

  const unpackedGame = await modFromFolder('CLV-H-ABCDE', folder(GAME));
  assert.equal(unpackedGame.kind, 'game');
  assert.equal(unpackedGame.readme.front.Name, 'Test Game', 'title comes from the .desktop file');

  const unclear = await modFromArchive('mystery.clvg', await tgz({ 'data.bin': 'x' }));
  assert.equal(unclear.kind, 'game');
  assert.equal(unclear.source.kindFrom, 'name');
});

test('the Mod / Game switch overrides detection', async () => {
  const m = await modFromArchive('test_mod.hmod', await tgz(MOD));
  const asGame = setKind(m, 'game');
  assert.equal(asGame.kind, 'game');
  assert.equal(asGame.source.kindFrom, 'manual');
  assert.ok(!validate(asGame).some((i) => i.id === 'kind-mismatch'));
});

test('a folder of packages becomes one package each', async () => {
  const files = [
    { path: 'a_mod.hmod', data: await tgz(MOD) },
    { path: 'games/CLV-H-ABCDE - Test Game.clvg', data: await tgz(GAME) },
    ...folder({ 'unpacked.hmod/etc/preinit.d/p8000_u': 'echo u\n', 'unpacked.hmod/readme.md': FULL_README }),
    ...folder({ 'notes.txt': 'not a package' }),
  ];
  assert.ok(looksLikePackageFolder(files));
  assert.ok(!looksLikePackageFolder(folder(MOD)), 'an unpacked mod is not a folder of packages');
  const r = await modsFromPackageFolder(files);
  assert.deepEqual(r.mods.map((m) => `${m.name}:${m.kind}`), ['a_mod:hmod', 'CLV-H-ABCDE - Test Game:game', 'unpacked:hmod']);
  assert.deepEqual(r.skipped, ['notes.txt']);
});

test('files can be renamed and moved, with sensible refusals', async () => {
  const m = await modFromArchive('test_mod.hmod', await tgz({ ...MOD, 'usr/share/a.txt': 'a' }));
  const moved = renameFile(m, 'usr/share/a.txt', '/usr/share/test/b.txt');
  assert.ok(moved.mod.files.some((f) => f.path === 'usr/share/test/b.txt'));
  assert.match(renameFile(m, 'usr/share/a.txt', 'uninstall').error, /already exists/);
  assert.match(renameFile(m, 'usr/share/a.txt', '../escape').error, /\.\./);
  assert.match(renameFile(m, 'usr/share/a.txt', 'readme.md').error, /Readme tab/);
  assert.match(renameFile(m, 'usr/share/a.txt', 'etc').error, /folder/);
  assert.match(renameFile(m, 'usr/share/a.txt', '  ').error, /Enter a path/);
});
