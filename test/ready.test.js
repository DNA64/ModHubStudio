import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, zip, readme, desktop, ids, FULL_README } from './helpers.js';
import { modFromArchive } from '../src/model.js';
import { validate } from '../src/rules.js';
import { isReady, setReady, missingRequired, missingOptional, confirmComplete, alreadyPublished } from '../src/ready.js';
import { packageFromItem } from '../src/import.js';


const mod = async (fields) => ({ ...(await modFromArchive('tester.x.hmod', await tgz({ 'readme.md': readme(fields), 'usr/share/x/a': 'a' }))), targets: ['snes'] });

test('Name, Creator, Category and Version are required', async () => {
  const partial = await mod({ Name: 'X', Version: '1' });
  assert.deepEqual(missingRequired(partial), ['Creator', 'Category']);
  const issue = validate(partial).find((i) => i.id === 'readme-fields');
  assert.equal(issue.severity, 'error');
  assert.match(issue.title, /Creator, Category/);
  const full = await mod({ Name: 'X', Creator: 'me', Category: 'Tweak', Version: '1' });
  assert.ok(!ids(validate(full)).includes('readme-fields'));
  assert.deepEqual(missingOptional(full), ['Maintainer', 'Emulated System', 'Prerequisite', 'Command Line', 'Tags']);
});

test('a game missing them is warned, not failed (a central repository keeps no listing for games)', async () => {
  const g = await modFromArchive('CLV-Z-ABCDE.clvg', await zip({ 'CLV-Z-ABCDE.desktop': desktop('CLV-Z-ABCDE', '/bin/x') }));
  assert.equal(validate(g).find((i) => i.id === 'readme-fields').severity, 'warning');
  assert.deepEqual(missingRequired(g), ['Creator', 'Category', 'Version', 'Consoles'], 'Name comes from the .desktop file');
});

test('Ready to publish can only be ticked when the required fields are filled', async () => {
  const partial = await mod({ Name: 'X' });
  assert.equal(isReady(partial), false);
  assert.equal(isReady(setReady(partial, true)), false);
  const full = await mod({ Name: 'X', Creator: 'me', Category: 'Tweak', Version: '1' });
  assert.equal(isReady(full), false, 'not ticked yet');
  const ticked = setReady(full, true);
  assert.equal(isReady(ticked), true);
  const cleared = { ...ticked, readme: { ...ticked.readme, front: { ...ticked.readme.front, Version: '' } } };
  assert.equal(isReady(cleared), false, 'emptying a required field makes it not ready');
});

test('Confirm all complete readmes ticks only the complete ones', async () => {
  const a = await mod({ Name: 'A', Creator: 'me', Category: 'Tweak', Version: '1' });
  const b = await mod({ Name: 'B' });
  const c = setReady(await mod({ Name: 'C', Creator: 'me', Category: 'Tweak', Version: '2' }), true);
  const out = confirmComplete([a, b, c]);
  assert.deepEqual(out.map(isReady), [true, false, true]);
  assert.equal(out[2], c, 'an already ticked package is left as it is');
});

test('packages published unchanged from an opened repository count as ready', async () => {
  const bytes = await tgz({ 'readme.md': readme({ Name: 'Old' }), 'usr/share/x/a': 'a' });
  const { mod: m } = await packageFromItem({ fileName: 'old.hmod', link: 'https://x.example/m/old.hmod' }, bytes);
  assert.ok(alreadyPublished(m) && isReady(m), 'missing fields, but it is published exactly as it already was');
  const edited = { ...m, readme: { ...m.readme, front: { ...m.readme.front, Version: '2' } } };
  assert.ok(!alreadyPublished(edited) && !isReady(edited), 'once changed, it needs its readme and the tick');
  const { mod: gone } = await packageFromItem({ fileName: 'gone.hmod', link: 'https://x.example/m/gone.hmod' }, null, 'Dead link.');
  assert.ok(isReady(gone), "a package that couldn't be downloaded can't be changed");
});

test('at least one console must be selected before it is ready', async () => {
  const full = await mod({ Name: 'X', Creator: 'me', Category: 'Tweak', Version: '1' });
  const none = { ...full, targets: [] };
  assert.deepEqual(missingRequired(none), ['Consoles']);
  assert.equal(isReady(setReady(none, true)), false);
  assert.equal(isReady(setReady(full, true)), true);
});
