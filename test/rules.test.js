import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, zip, ids, readme, FULL_README, textBytes, bytesText } from './helpers.js';
import { buildTar } from '../src/tar.js';
import { modFromArchive } from '../src/model.js';
import { validate, applyFix, applyAllFixes, destination, fileMode } from '../src/rules.js';

const mod = async (spec, name = 'test_mod.hmod') => modFromArchive(name, await tgz(spec));
const blocking = (issues) => issues.filter((i) => i.severity !== 'info');

test('a well-formed mod has no errors or warnings', async () => {
  const m = await mod({
    'readme.md': FULL_README,
    install: 'mkdir -p "$rootfs/usr/share/test"\nreturn 0\n',
    uninstall: 'rm -rf "$rootfs/usr/share/test"\n',
    'etc/preinit.d/p8100_test': 'test_fn(){\n  return 0\n}\n',
    'usr/bin/test-tool': { data: '#!/bin/sh\necho hi\n', mode: 0o755 },
    'usr/share/test/data.bin': new Uint8Array(32),
  });
  assert.deepEqual(blocking(validate(m)), []);
});

test('a wrapper folder is an error, and the rest is still checked', async () => {
  const m = await mod({ 'MyMod/readme.md': FULL_README, 'MyMod/etc/preinit.d/p8100_x': 'echo x' });
  const found = ids(validate(m));
  assert.ok(found.includes('wrapper'));
  assert.ok(found.includes('preinit-newline'), 'problems inside the wrapper are reported too');
  const fixed = applyFix(m, 'wrapper');
  assert.deepEqual(fixed.files.map((f) => f.path), ['etc/preinit.d/p8100_x']);
  assert.equal(fixed.readme.front.Name, 'Test Mod', 'the readme inside the wrapper is picked up');
});

test('rootfs prefix, capitalisation, backslashes and junk are fixable', async () => {
  const m = await mod({
    'readme.md': FULL_README,
    'var/lib/hakchi/rootfs/usr/share/a.txt': 'a',
    'Usr/Share/b.txt': 'b',
    'usr\\share\\c.txt': 'c',
    '.DS_Store': 'junk',
    '__MACOSX/._x': 'junk',
  });
  const found = ids(validate(m));
  for (const id of ['rootfs-prefix', 'root-case', 'backslash-paths', 'junk']) assert.ok(found.includes(id), id);
  const fixed = applyAllFixes(m);
  assert.deepEqual(fixed.files.map((f) => f.path).sort(), ['usr/share/a.txt', 'usr/share/b.txt', 'usr/share/c.txt']);
  assert.deepEqual(blocking(validate(fixed)), []);
});

test('files outside the overlay are flagged by where they would land', async () => {
  const m = await mod({
    'readme.md': FULL_README,
    'loose.bin': 'x',
    'opt/tool': 'x',
    'var/lib/thing': 'x',
    'extra.hmod': 'x',
    'NOTES.txt': 'x',
  });
  const found = ids(validate(m));
  for (const id of ['loose-root', 'unknown-root', 'runtime-root', 'nested-hmod', 'dropped-docs']) assert.ok(found.includes(id), id);
});

test('boot script rules follow source_parts and the shared shell', async () => {
  const m = await mod({
    'readme.md': FULL_README,
    'etc/preinit.d/mymod': 'echo never runs\n',
    'etc/preinit.d/p0500_early': 'echo early\n',
    'etc/preinit.d/b8000_funcs': 'f(){ :; }\n',
    'etc/preinit.d/p8000_noeol': 'echo x',
    'etc/preinit.d/p8001_exit': 'exit 0\n',
    'etc/preinit.d/p8002_bin': new Uint8Array([0x7f, 0, 1, 2]),
  });
  const found = ids(validate(m));
  for (const id of ['preinit-name', 'preinit-order', 'preinit-b', 'preinit-newline', 'preinit-exit', 'preinit-binary']) assert.ok(found.includes(id), id);
  assert.equal(destination('etc/preinit.d/mymod').kind, 'dead');
  assert.equal(destination('etc/preinit.d/p8000_ok').kind, 'boot');
});

test('control scripts: exit, missing return and no-uninstall', async () => {
  const m = await mod({
    'readme.md': FULL_README,
    install: 'cp a b\n',
    transfer: 'exit 1\n',
    uninstall: 'no-uninstall\n',
  });
  const found = ids(validate(m));
  for (const id of ['install-return', 'exit-transfer', 'no-uninstall']) assert.ok(found.includes(id), id);
  const fixed = applyFix(m, 'install-return');
  assert.match(bytesText(fixed.files.find((f) => f.path === 'install').data), /return 0\n$/);
});

test('CRLF scripts and missing executable bits are fixed', async () => {
  const m = await mod({
    'readme.md': FULL_README,
    'usr/share/test/run.sh': { data: '#!/bin/sh\r\necho hi\r\n', mode: 0o644 },
  });
  const found = ids(validate(m));
  assert.ok(found.includes('crlf-exec'));
  assert.ok(found.includes('exec-bit'));
  const fixed = applyAllFixes(m);
  const f = fixed.files.find((x) => x.path === 'usr/share/test/run.sh');
  assert.equal(bytesText(f.data), '#!/bin/sh\necho hi\n');
  assert.equal(fileMode(f), 0o755);
});

test('file modes follow what hakchi chmods', () => {
  assert.equal(fileMode({ path: 'usr/bin/x', type: 'file', mode: 0o600 }), 0o755);
  assert.equal(fileMode({ path: 'etc/init.d/S99x', type: 'file', mode: null }), 0o755);
  assert.equal(fileMode({ path: 'etc/preinit.d/p8000_x', type: 'file', mode: 0o755 }), 0o644);
  assert.equal(fileMode({ path: 'install', type: 'file', mode: 0o755 }), 0o644);
  assert.equal(fileMode({ path: 'usr/share/x', type: 'file', mode: null }), 0o644);
});

test('package names are checked like Hakchi2 CE cleans them', async () => {
  const m = await mod({ 'readme.md': FULL_README, 'usr/share/x': 'x' }, 'My Mod (v2).hmod');
  assert.ok(ids(validate(m)).includes('bad-name'));
  assert.equal(applyFix(m, 'bad-name').name, 'My_Mod__v2_');
  const black = await mod({ 'readme.md': FULL_README, 'usr/share/x': 'x' }, 'clovershell.hmod');
  assert.ok(ids(validate(black)).includes('blacklisted'));
});

test('readme problems: missing, late front matter, missing fields', async () => {
  assert.ok(ids(validate(await mod({ 'usr/share/x': 'x' }))).includes('readme-missing'));
  const late = await mod({ 'readme.md': '\n' + FULL_README, 'usr/share/x': 'x' });
  assert.ok(ids(validate(late)).includes('readme-top'));
  assert.equal(late.readme.front.Name, 'Test Mod', 'late front matter is still recovered');
  const partial = await mod({ 'readme.md': readme({ Name: 'X' }), 'usr/share/x': 'x' });
  assert.match(validate(partial).find((i) => i.id === 'readme-fields').title, /Creator, Category, Version/);
});

test('ZIP and plain tar containers are noted', async () => {
  const fromZip = await modFromArchive('z.hmod', await zip({ 'readme.md': FULL_README, 'usr/share/x': 'x' }));
  assert.ok(ids(validate(fromZip)).includes('container-zip'));
  const plain = await modFromArchive('t.hmod', buildTar([{ path: 'usr/share/x', type: 'file', data: textBytes('x'), mode: 0o644 }]));
  assert.ok(ids(validate(plain)).includes('container-tar'));
});

test('theme files in a folder no console reads can be moved', async () => {
  const m = await mod({
    'readme.md': FULL_README,
    'usr/share/ui/snes/resources/bg.png': 'x',
    'usr/share/ui/snes-usa/resources/menu.png': 'x',
  });
  assert.ok(ids(validate(m)).includes('ui-move'));
  const fixed = applyFix(m, 'ui-move');
  assert.ok(fixed.files.some((f) => f.path === 'usr/share/ui/snes-usa/resources/bg.png'));
  assert.equal(destination('usr/share/ui/snes/x.png').kind, 'dead');
});

test('dismissed findings stay hidden', async () => {
  const m = await mod({ 'usr/share/x': 'x' });
  assert.ok(ids(validate(m)).includes('readme-missing'));
  assert.ok(!ids(validate({ ...m, dismissed: ['readme-missing'] })).includes('readme-missing'));
});
