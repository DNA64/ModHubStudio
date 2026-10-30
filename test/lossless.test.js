import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, unpack, textBytes, ids, FULL_README } from './helpers.js';
import { buildTar, gzip, parseTar } from '../src/tar.js';
import { modFromArchive } from '../src/model.js';
import { validate } from '../src/rules.js';
import { packHmod } from '../src/pack.js';

function setTypeflag(tar, name, flag, linkname = '') {
  const out = tar.slice();
  for (let off = 0; off + 512 <= out.length;) {
    const n = new TextDecoder().decode(out.subarray(off, off + 100)).replace(/\0.*$/s, '');
    const size = parseInt(new TextDecoder().decode(out.subarray(off + 124, off + 136)).replace(/\0.*$/s, '').trim() || '0', 8);
    if (n === name) {
      out[off + 156] = flag.charCodeAt(0);
      out.set(textBytes(linkname), off + 157);
      out.fill(0x20, off + 148, off + 156);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += out[off + i];
      out.set(textBytes(sum.toString(8).padStart(6, '0') + '\0 '), off + 148);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const file = (path, text, mode = 0o644) => ({ path, type: 'file', data: textBytes(text), mode });

test('a hardlink is kept as a copy of the file it points to', async () => {
  const raw = buildTar([file('readme.md', FULL_README), file('usr/share/x/a', 'data'), file('usr/share/x/b', '')]);
  const linked = setTypeflag(raw, 'usr/share/x/b', '1', 'usr/share/x/a');
  assert.equal(parseTar(linked).find((e) => e.path === 'usr/share/x/b').data.length, 4);
  const mod = await modFromArchive('t.hmod', await gzip(linked));
  const packed = await unpack(await packHmod(mod));
  assert.equal(packed['usr/share/x/a'].text, 'data');
  assert.equal(packed['usr/share/x/b'].text, 'data');
});

test('a hardlink to a missing file is dropped, not guessed', () => {
  const raw = buildTar([file('a', 'x')]);
  assert.deepEqual(parseTar(setTypeflag(raw, 'a', '1', 'nowhere')), []);
});

test('empty directories survive packing', async () => {
  const raw = buildTar([
    file('readme.md', FULL_README),
    { path: 'usr/share/x/saves', type: 'dir', mode: 0o755 },
    { path: 'usr/share/x/full', type: 'dir', mode: 0o755 },
    file('usr/share/x/full/a', 'a'),
  ]);
  const mod = await modFromArchive('t.hmod', await gzip(raw));
  const t = await unpack(await packHmod(mod));
  assert.equal(t['usr/share/x/saves/'].type, 'dir');
  assert.equal(t['usr/share/x/full/'].type, 'dir');
  assert.equal(Object.keys(t).filter((k) => k === 'usr/share/x/saves/').length, 1);
});

test('an empty directory at the root does not count as a loose file', async () => {
  const raw = buildTar([file('readme.md', FULL_README), { path: 'etc', type: 'dir', mode: 0o755 }, { path: 'usr/bin/x', type: 'file', data: textBytes('#!/bin/sh\n'), mode: 0o755 }]);
  const mod = await modFromArchive('t.hmod', await gzip(raw));
  assert.ok(!ids(validate(mod)).includes('loose-root'));
});

const check = async (spec) => ids(validate(await modFromArchive('t.hmod', await tgz({ 'readme.md': FULL_README, ...spec }))));

test('exit is found after || && ; and in then/else branches', async () => {
  for (const line of ['[ -f /x ] || exit 0', 'true && exit 1', 'echo a; exit 0', 'if true; then exit 0; fi', 'if true; then\n  exit\nfi']) {
    assert.ok((await check({ 'etc/preinit.d/p8100_x': `${line}\n` })).includes('preinit-exit'), line);
    assert.ok((await check({ install: `${line}\nreturn 0\n` })).includes('exit-install'), line);
  }
});

test('words that only contain exit are not flagged', async () => {
  for (const line of ['echo exit', 'grep -q exit /etc/x', 'EXIT_CODE=1', '# exit', 'myexit']) {
    assert.ok(!(await check({ 'etc/preinit.d/p8100_x': `${line}\n` })).includes('preinit-exit'), line);
  }
});

test('return at the top of a boot script is an error, inside a function it is fine', async () => {
  assert.ok((await check({ 'etc/preinit.d/p8100_x': 'echo a\nreturn 0\n' })).includes('preinit-return'));
  assert.ok((await check({ 'etc/preinit.d/p8100_x': '[ -f /x ] || return 0\n' })).includes('preinit-return'));
  assert.ok((await check({ 'etc/preinit.d/p8100_x': 'if true; then\n  return 0\nfi\n' })).includes('preinit-return'));
  const inFunction = 'mymod_start() {\n  [ -f /x ] || return 0\n  echo ${HOME}\n}\nmymod_start\n';
  assert.ok(!(await check({ 'etc/preinit.d/p8100_x': inFunction })).includes('preinit-return'));
  assert.ok(!(await check({ 'etc/preinit.d/p8100_x': 'f() { return 0; }\nf\n' })).includes('preinit-return'), 'one-line function');
  assert.ok(!(await check({ 'etc/preinit.d/p8100_x': 'f() { [ -f /x ] || return 0\n  echo a\n}\nf\n' })).includes('preinit-return'), 'return on the opening line');
  assert.ok((await check({ 'etc/preinit.d/p8100_x': 'f() { echo a; }\nf || return 0\n' })).includes('preinit-return'), 'after a closed function');
  assert.ok(!(await check({ install: 'echo a\nreturn 0\n' })).includes('preinit-return'), 'install may return');
});

test('.. in a path is an error', async () => {
  assert.ok((await check({ '../evil': 'x' })).includes('path-dotdot'));
});
