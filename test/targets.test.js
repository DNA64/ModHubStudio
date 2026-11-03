import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgz, ids, desktop, elf, ELF_ARM, ELF_X86, readme, FULL_README } from './helpers.js';
import { modFromArchive } from '../src/model.js';
import { validate } from '../src/rules.js';
import { resolveTargets, detectTargets, parseConsolesField } from '../src/targets.js';
import { readmeText } from '../src/pack.js';

const mod = async (spec, name = 'test_mod.hmod') => modFromArchive(name, await tgz(spec));
const game = (code, exec, extra = {}) => mod({ [`${code}.desktop`]: desktop(code, exec), ...extra }, `${code}.clvg`);

test('the Consoles field accepts common spellings', () => {
  assert.deepEqual(parseConsolesField('SNES'), ['snes']);
  assert.deepEqual(parseConsolesField('NES, Super Famicom'), ['nes', 'snes']);
  assert.deepEqual(parseConsolesField('Genesis / Mega Drive'), ['sega']);
  assert.deepEqual(parseConsolesField('Genesis'), ['sega'], '"Genesis" is not NES');
  assert.deepEqual(parseConsolesField('Super Nintendo'), ['snes']);
  assert.deepEqual(parseConsolesField('Famicom Mini & Shonen Jump'), ['nes']);
  assert.deepEqual(parseConsolesField('all'), ['nes', 'snes', 'sega']);
  assert.equal(parseConsolesField('toaster'), null);
});

test('targets come from the buttons, then the readme; nothing is selected by default', async () => {
  const fromReadme = await mod({ 'readme.md': readme({ Name: 'x', Consoles: 'NES' }), 'usr/share/x': 'x' });
  assert.deepEqual(resolveTargets(fromReadme), { ids: ['nes'], from: 'readme' });

  const snesTheme = await mod({ 'readme.md': FULL_README, 'usr/share/ui/snes-usa/resources/bg.png': 'x' });
  assert.deepEqual(resolveTargets(snesTheme), { ids: [], from: 'none' }, 'contents only suggest');
  assert.deepEqual(detectTargets(snesTheme).ids, ['snes']);
  assert.match(validate(snesTheme).find((i) => i.id === 'targets-none').detail, /point at SNES/);

  const callsCanoe = await mod({ 'readme.md': FULL_README, 'etc/preinit.d/p8000_x': 'clover-canoe-shvc --flag\n' });
  assert.deepEqual(detectTargets(callsCanoe).ids, ['snes']);

  const generic = await mod({ 'readme.md': FULL_README, 'usr/share/x': 'x' });
  assert.deepEqual(resolveTargets(generic), { ids: [], from: 'none' });
  assert.equal(validate(generic).find((i) => i.id === 'targets-none').severity, 'warning');

  const picked = { ...generic, targets: ['sega'] };
  assert.deepEqual(resolveTargets(picked), { ids: ['sega'], from: 'manual' });
  assert.ok(!ids(validate(picked)).includes('targets-none'));
  const cleared = { ...fromReadme, targets: [] };
  assert.deepEqual(resolveTargets(cleared), { ids: [], from: 'manual' }, 'turning every console off overrides the readme');
});

test('every selected console is written to the readme for the Mod Hub', async () => {
  const m = await mod({ 'readme.md': FULL_README, 'usr/share/x': 'x' });
  assert.match(readmeText({ ...m, targets: ['nes', 'snes'] }), /^Compatible System\(s\): NES, SNES$/m);
  assert.match(readmeText({ ...m, targets: ['nes', 'snes', 'sega'] }), /^Compatible System\(s\): NES, SNES, SEGA$/m, 'all three are listed too');
  assert.doesNotMatch(readmeText(m), /Compatible System|Consoles:/, 'none selected writes no line');
  // A readme written with the old field name is read, and written back under the new one.
  const old = await mod({ 'readme.md': readme({ Name: 'x', Consoles: 'SNES', Version: '1' }), 'usr/share/x': 'x' });
  assert.deepEqual(resolveTargets(old).ids, ['snes']);
  const text = readmeText(old);
  assert.match(text, /^Compatible System\(s\): SNES$/m);
  assert.doesNotMatch(text, /^Consoles:/m);
  assert.deepEqual(resolveTargets(await mod({ 'readme.md': readme({ Name: 'x', 'Compatible System(s)': 'NES, SEGA' }) })).ids, ['nes', 'sega']);
});

test('parts for consoles the package is not set for are flagged', async () => {
  const m = await mod({
    'readme.md': readme({ Name: 'T', Creator: 'c', Category: 'Theme', Version: '1', Consoles: 'SNES' }),
    'usr/share/ui/snes-usa/resources/a.png': 'x',
    'usr/share/clover-ui/resources/b.png': 'x',
  });
  const found = ids(validate(m));
  assert.ok(found.includes('targets-stray-nes'));
  assert.ok(found.includes('targets-region-snes'), 'only SNES USA is covered');
});

test('a theme set for a console it has no menu files for is flagged', async () => {
  const m = await mod({ 'readme.md': FULL_README, 'usr/share/ui/snes-usa/resources/a.png': 'x' });
  assert.ok(ids(validate({ ...m, targets: ['nes', 'snes'] })).includes('targets-theme-missing-nes'));
  assert.ok(!ids(validate(m)).some((id) => id.startsWith('targets-theme-missing') || id.startsWith('targets-stray')), 'nothing selected, nothing to compare');
});

test('games: stock emulator must exist on the target and open the ROM', async () => {
  const found = await game('CLV-H-AAAAA', '/bin/clover-kachikachi-wr /var/games/CLV-H-AAAAA/x.nes');
  assert.deepEqual(detectTargets(found).ids, ['nes']);
  const nes = { ...found, targets: ['nes'] };
  assert.ok(!validate(nes).some((i) => i.severity === 'error'));

  const wrongRom = await game('CLV-H-BBBBB', '/bin/clover-kachikachi-wr /var/games/CLV-H-BBBBB/sonic.bin');
  assert.ok(ids(validate(wrongRom)).includes('game-rom-ext'));

  const onSega = { ...nes, targets: ['sega'] };
  const stray = validate(onSega).find((i) => i.id === 'targets-stray-nes');
  assert.equal(stray.severity, 'error', "a NES-only emulator can't run on SEGA");

  const retro = await game('CLV-H-CCCCC', '/bin/fceumm /var/games/CLV-H-CCCCC/x.nes');
  assert.ok(ids(validate(retro)).includes('game-retroarch'));
});

test('games: .desktop rules from Hakchi2 CE import', async () => {
  const noDesktop = await mod({ 'CLV-H-DDDDD/x.nes': 'x' }, 'x.clvg');
  assert.ok(ids(validate(noDesktop)).includes('game-no-desktop'));
  const noExec = await mod({ 'CLV-H-EEEEE.desktop': 'Name=Only a name\n' }, 'x.clvg');
  assert.ok(ids(validate(noExec)).includes('game-desktop-keys'));
  const oddCode = await game('MYGAME', '/bin/fceumm /var/games/MYGAME/x.nes');
  assert.ok(ids(validate(oddCode)).includes('game-code'));
  const withArt = await game('CLV-H-FFFFF', '/bin/fceumm x.nes', { 'CLV-H-FFFFF.png': 'png' });
  assert.ok(!ids(validate(withArt)).includes('game-art'));
});

test('programs must be built for ARM', async () => {
  const arm = await mod({ 'readme.md': FULL_README, 'usr/bin/tool': elf(ELF_ARM) });
  assert.ok(!ids(validate(arm)).includes('elf-arch'));
  const x86 = await mod({ 'readme.md': FULL_README, 'usr/bin/tool': elf(ELF_X86) });
  const issue = validate(x86).find((i) => i.id === 'elf-arch');
  assert.equal(issue.severity, 'error');
  assert.match(issue.detail, /x86/);
});
