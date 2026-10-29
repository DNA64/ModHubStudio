import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { parseReadme, serializeReadme } from '../src/readme.js';

test('front matter is parsed like Hakchi2 CE does', () => {
  const r = parseReadme('---\nName: Splash\nCreator: someone\nVersion: 2\n---\n# Hello\n');
  assert.deepEqual(r.front, { Name: 'Splash', Creator: 'someone', Version: '2' });
  assert.equal(r.body, '# Hello');
  assert.ok(r.hadFrontMatter);
});

test('the first value wins for repeated keys', () => {
  assert.equal(parseReadme('---\nName: A\nName: B\n---\n').front.Name, 'A');
});

test('front matter after leading blank lines is flagged', () => {
  const r = parseReadme('\n\n---\nName: Late\n---\nbody');
  assert.ok(r.frontMatterNotAtTop);
  assert.ok(!r.hadFrontMatter);
});

test('a readme without front matter is just a body', () => {
  const r = parseReadme('Just text.');
  assert.deepEqual(r.front, {});
  assert.equal(r.body, 'Just text.');
});

test('serialize writes standard fields first and skips empty ones', () => {
  const text = serializeReadme({ front: { Custom: 'x', Version: '1', Name: 'N', Creator: '' }, order: ['Custom'], body: 'Body' });
  assert.equal(text, '---\nName: N\nVersion: 1\nCustom: x\n---\nBody\n');
  assert.deepEqual(parseReadme(text).front, { Name: 'N', Version: '1', Custom: 'x' });
});
