import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { buildTar, parseTar, gzip, gunzip, isGzip, isZip, looksLikeTar, textBytes, bytesText } from '../src/tar.js';

test('tar round-trips files, folders, modes and symlinks', () => {
  const tar = buildTar([
    { path: 'usr', type: 'dir', mode: 0o755 },
    { path: 'usr/bin/tool', type: 'file', data: textBytes('#!/bin/sh\n'), mode: 0o755 },
    { path: 'usr/lib/link.so', type: 'symlink', linkname: 'real.so', mode: 0o777 },
  ]);
  assert.ok(looksLikeTar(tar));
  assert.equal(tar.length % 512, 0);
  const back = parseTar(tar);
  assert.deepEqual(back.map((e) => [e.path, e.type]), [['usr/', 'dir'], ['usr/bin/tool', 'file'], ['usr/lib/link.so', 'symlink']]);
  assert.equal(back[1].mode, 0o755);
  assert.equal(bytesText(back[1].data), '#!/bin/sh\n');
  assert.equal(back[2].linkname, 'real.so');
});

test('tar keeps paths longer than 100 characters', () => {
  const ustar = 'usr/share/' + 'a'.repeat(120) + '/file.txt';
  const gnu = 'b'.repeat(140) + '.txt'; // no slash to split on, needs a GNU long name
  const back = parseTar(buildTar([
    { path: ustar, type: 'file', data: textBytes('1'), mode: 0o644 },
    { path: gnu, type: 'file', data: textBytes('2'), mode: 0o644 },
  ]));
  assert.deepEqual(back.map((e) => e.path), [ustar, gnu]);
});

test('tar entries are owned by root', () => {
  const tar = buildTar([{ path: 'x', type: 'file', data: textBytes('x'), mode: 0o644 }]);
  assert.equal(bytesText(tar.subarray(265, 269)), 'root');
  assert.equal(bytesText(tar.subarray(297, 301)), 'root');
});

test('gzip round-trips and format sniffing works', async () => {
  const data = textBytes('hello hakchi');
  const gz = await gzip(data);
  assert.ok(isGzip(gz));
  assert.ok(!isZip(gz));
  assert.equal(bytesText(await gunzip(gz)), 'hello hakchi');
});
