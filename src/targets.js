// Console targets, from hakchi2-CE hakchi.cs (ConsoleType, IsNes/IsSnes),
// Apps/BuiltInCores.cs (stock emulators) and hakchi's fontfix (UI folders).
import { bytesText } from './tar.js';

export const TARGETS = {
  nes: {
    label: 'NES',
    consoles: 'NES Classic, Famicom Mini, Shonen Jump Famicom',
    emulator: 'clover-kachikachi',
    romExts: ['.nes', '.fds', '.qd'],
    ui: { 'usr/share/clover-ui/': 'NES Classic and Famicom Mini', 'usr/share/ui/hvc/': 'Shonen Jump Famicom' },
  },
  snes: {
    label: 'SNES',
    consoles: 'SNES Classic (USA, EUR), Super Famicom Mini',
    emulator: 'clover-canoe-shvc',
    romExts: ['.sfrom', '.sfc', '.smc'],
    ui: { 'usr/share/ui/snes-usa/': 'SNES Classic (North America)', 'usr/share/ui/snes-eur/': 'SNES Classic (Europe/Australia)', 'usr/share/ui/shvc/': 'Super Famicom Mini' },
  },
  sega: {
    label: 'SEGA',
    consoles: 'Mega Drive / Genesis Mini (USA, EUR, JPN, Asia)',
    emulator: 'm2engage',
    romExts: ['.bin'],
    ui: {},
  },
};
export const TARGET_IDS = Object.keys(TARGETS);

const isText = (u8) => {
  const n = Math.min(u8.length, 4096);
  for (let i = 0; i < n; i++) if (u8[i] === 0) return false;
  return true;
};
const listOf = (ids) => ids.map((t) => TARGETS[t].label).join(', ');

export function parseConsolesField(value) {
  if (!value) return null;
  const ids = [];
  for (const part of String(value).split(/[,/&+]|\band\b/i)) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    if (/^(all|any)$/.test(p)) return [...TARGET_IDS];
    // Whole words only: "Genesis" contains "nes".
    if (/\b(sega|genesis|mega\s*drive|megadrive|md)\b/.test(p)) ids.push('sega');
    else if (/\b(snes|super\s*(nintendo|famicom|nes)|sfc|shvc)\b/.test(p)) ids.push('snes');
    else if (/\b(nes|famicom|hvc|shonen(\s*jump)?)\b/.test(p)) ids.push('nes');
  }
  return ids.length ? [...new Set(ids)] : null;
}

export function formatConsolesField(ids) {
  return TARGET_IDS.filter((t) => ids.includes(t)).map((t) => TARGETS[t].label).join(', ');
}

function nativeEmulator(text) {
  for (const id of TARGET_IDS) if (text.includes(TARGETS[id].emulator)) return id;
  return null;
}

// What the package itself says about which consoles it is for.
// Returns { ids, evidence: [{target, reason, path}] }.
export function detectTargets(mod) {
  const evidence = [];
  if (mod.kind === 'game') {
    const desktop = mod.files.find((f) => /^[^/]+\.desktop$/i.test(f.path));
    const exec = desktop ? (bytesText(desktop.data).match(/^Exec=(.*)$/m) || [])[1] || '' : '';
    const native = nativeEmulator(exec);
    if (native) evidence.push({ target: native, reason: `launches with ${TARGETS[native].emulator}`, path: desktop.path });
    return { ids: native ? [native] : [], evidence, exec };
  }
  for (const f of mod.files) {
    for (const id of TARGET_IDS) {
      for (const prefix of Object.keys(TARGETS[id].ui)) {
        if (f.path.startsWith(prefix)) evidence.push({ target: id, reason: `UI files for ${TARGETS[id].ui[prefix]}`, path: f.path });
      }
    }
    if (f.path.startsWith('usr/share/games/nes/kachikachi/')) evidence.push({ target: 'nes', reason: 'NES game folder', path: f.path });
    if (f.type === 'file' && f.data.length < 512 * 1024 && isText(f.data)) {
      const text = bytesText(f.data);
      for (const id of TARGET_IDS) {
        if (text.includes(TARGETS[id].emulator)) evidence.push({ target: id, reason: `calls ${TARGETS[id].emulator}`, path: f.path });
      }
    }
  }
  return { ids: TARGET_IDS.filter((t) => evidence.some((e) => e.target === t)), evidence };
}

// Settled targets for a package: chosen by hand, then readme, then contents, else all.
export function resolveTargets(mod) {
  if (mod.targets && mod.targets.length) return { ids: mod.targets, from: 'manual' };
  const fromReadme = parseConsolesField(mod.readme?.front?.Consoles);
  if (fromReadme) return { ids: fromReadme, from: 'readme' };
  const detected = detectTargets(mod);
  if (detected.ids.length) return { ids: detected.ids, from: 'contents' };
  return { ids: [...TARGET_IDS], from: 'none' };
}

function elfMachine(u8) {
  if (u8.length < 20 || u8[0] !== 0x7f || u8[1] !== 0x45 || u8[2] !== 0x4c || u8[3] !== 0x46) return null;
  return u8[5] === 2 ? (u8[18] << 8) | u8[19] : u8[18] | (u8[19] << 8);
}
const ELF_NAMES = { 3: 'x86', 62: 'x86-64', 8: 'MIPS', 40: 'ARM', 183: 'ARM64' };

// add(id, severity, title, detail, paths, fixLabel)
export function validateTargets(mod, add) {
  const { ids, from } = resolveTargets(mod);
  const detected = detectTargets(mod);
  const others = TARGET_IDS.filter((t) => !ids.includes(t));

  // Programs built for a desktop PC never run on any of these consoles (all ARM).
  const wrongArch = mod.files.filter((f) => {
    const m = f.type === 'file' ? elfMachine(f.data) : null;
    return m != null && m !== 40;
  });
  if (wrongArch.length) add('elf-arch', 'error', 'Programs built for the wrong processor',
    `Every supported console runs 32-bit ARM Linux. These are ${[...new Set(wrongArch.map((f) => ELF_NAMES[elfMachine(f.data)] || `machine ${elfMachine(f.data)}`))].join(', ')} binaries and fail with "not found" or "exec format error".`,
    wrongArch.map((f) => f.path));

  if (from === 'none' && mod.kind !== 'game') {
    add('targets-unknown', 'info', 'Not tied to a console',
      'Nothing in the package points at NES, SNES or SEGA, so it is treated as working on all of them. If it only suits some, set them under Consoles; that is written to the readme so the Mod Hub shows it.');
  }

  // Detected evidence for consoles outside the chosen targets.
  if (from !== 'contents') {
    for (const t of others) {
      const ev = detected.evidence.filter((e) => e.target === t);
      if (!ev.length) continue;
      add(`targets-stray-${t}`, mod.kind === 'game' ? 'error' : 'warning', `Contains ${TARGETS[t].label}-only parts`,
        mod.kind === 'game'
          ? `This game ${ev[0].reason}, which only exists on ${TARGETS[t].consoles}. It won't launch on ${listOf(ids)}.`
          : `These files are only used on ${TARGETS[t].consoles} (${[...new Set(ev.map((e) => e.reason))].join('; ')}), but the package is set for ${listOf(ids)}. They do nothing there.`,
        [...new Set(ev.map((e) => e.path))]);
    }
  }

  if (mod.kind === 'game') {
    const exec = detected.exec || '';
    const native = detected.ids[0];
    if (native) {
      const rom = (exec.match(/\/var\/games\/[^ ]+\/([^ /]+\.[A-Za-z0-9]+)/) || exec.match(/([^ /]+\.[A-Za-z0-9]{2,5})(\s|$)/) || [])[1];
      const ext = rom ? rom.slice(rom.lastIndexOf('.')).toLowerCase() : null;
      if (ext && !TARGETS[native].romExts.includes(ext) && !/\.gz$/.test(ext)) {
        add('game-rom-ext', 'error', `${TARGETS[native].emulator} can't run ${ext} files`,
          `The stock ${TARGETS[native].label} emulator takes ${TARGETS[native].romExts.join(', ')}. Point Exec at a RetroArch core for this ROM instead.`, [rom]);
      }
    } else if (exec) {
      const core = (exec.match(/^\/bin\/([^\s]+)/) || [])[1];
      add('game-retroarch', 'info', 'Runs through RetroArch',
        `Exec uses ${core ? `/bin/${core}` : 'a non-stock emulator'}, so the game works on any console that has the RetroArch hmod${core ? ` and the ${core} core` : ''} installed. Mention that in the description.`);
    }
    return;
  }

  // Theme coverage inside each chosen family.
  const isTheme = TARGET_IDS.some((t) => Object.keys(TARGETS[t].ui).some((p) => mod.files.some((f) => f.path.startsWith(p))));
  for (const t of ids) {
    const folders = Object.keys(TARGETS[t].ui);
    const used = folders.filter((p) => mod.files.some((f) => f.path.startsWith(p)));
    if (isTheme && !used.length && from !== 'none') {
      add(`targets-theme-missing-${t}`, 'warning', `Set for ${TARGETS[t].label}, but has no ${TARGETS[t].label} theme files`,
        folders.length
          ? `The menu on ${TARGETS[t].consoles} reads ${folders.join(', ')}, and this package has nothing there, so those consoles won't change.`
          : `${TARGETS[t].consoles} don't use the Nintendo UI folders this theme writes to, so it won't change anything there.`);
      continue;
    }
    if (!folders.length || !used.length) continue;
    const missing = folders.filter((p) => !used.includes(p));
    if (missing.length) add(`targets-region-${t}`, 'info', `Theme only covers part of ${TARGETS[t].label}`,
      `It changes ${used.map((p) => TARGETS[t].ui[p]).join(' and ')}, but not ${missing.map((p) => `${TARGETS[t].ui[p]} (${p})`).join(' or ')}. Say which consoles it supports in the readme, or include those folders too.`);
  }
}
