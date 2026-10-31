# Mod Hub Studio

    WORK IN PROGRESS: 
    This repository is still under development and is not ready for use. The old repository (https://classicmods.net/) still works, 
    but I'm in the process of giving it a much needed update, along with some new surprises! - Stay tunned!

Mod Hub Studio is a browser tool for Hakchi2 CE module and game authors. It checks an hmod against hakchi's own install rules, fixes common packaging mistakes, packs a proper `.hmod`, and publishes a Mod Hub repository: to your own GitHub Pages site, to any web host, or to a shared central repository by pull request.

Everything runs in the browser. Your files go nowhere until you publish, and then only to GitHub.

- [MMC Central Repository for Hakchi2 CE](https://github.com/DNA64/ModHubRepo), the default repository Mod Hub Studio submits packages to. Hakchi2 CE users add `https://dna64.github.io/ModHubRepo` as a Mod Hub repository. More details will be provided soon.

## Use it

Download `dist/index.html` and open it in a browser, or host it anywhere as a static page (GitHub Pages works). The page has three tabs:

| Tab | What it's for |
|---|---|
| Packages | Add packages and work on each one: checks and fixes, files, readme, consoles, download |
| Repository | The repository's name and description, the package list with versions, consoles and download links, and the files the site will contain |
| Publish | Your GitHub account, publishing your own Mod Hub site, and submitting packages to a central repository |

There are three ways to add packages on the Packages tab:

| Button | What to pick |
|---|---|
| Select a module | A `.hmod` module or `.clvg` game file (or several), the two package types Hakchi2 CE's Mod Hub knows |
| Select an unpacked module | One folder you're building a module in (`readme.md`, `install`, `etc/`, `usr/`…). It's checked and packed into a `.hmod` |
| Select multiple packages | A folder holding `.hmod` / `.clvg` files and unpacked `*.hmod` / `*.clvg` folders, the way Hakchi2 CE keeps `user_mods`. Each becomes its own package; other files are ignored |

Dragging a folder onto the page works out which of the last two it is.

### Mod or Game/Port

The contents decide whether a package is detected as a mod or a game:

- **Game:** a `.desktop` file at the top level (Hakchi2 CE imports a `.clvg` by its `CLV-X-XXXXX.desktop`) and no system folders.
- **Mod:** `install`, `uninstall` or `transfer`, or files under `bin`, `sbin`, `etc`, `lib`, `usr`, `root`.

When the contents are unclear, the `.hmod` / `.clvg` name decides, and anything else defaults to a mod. When the contents disagree with the extension, it's flagged as an error and packed with the right extension. A Module / Game switch on each package overrides the detection.

If a package only holds another archive (for example the `.tar` that 7-Zip shows inside a `.hmod`, or a folder holding that extracted `.tar`), the inner archive is opened and checked instead. A folder named after the package is treated as your working folder and skipped.

### Consoles

Each package targets NES, SNES, SEGA or a mix. The consoles come from Hakchi2 CE's own list (`hakchi.cs`):

| Target | Consoles | Stock emulator | Menu (UI) folders |
|---|---|---|---|
| NES | NES Classic, Famicom Mini, Shonen Jump Famicom | `clover-kachikachi` (.nes, .fds, .qd) | `usr/share/clover-ui`, `usr/share/ui/hvc` |
| SNES | SNES Classic (USA, EUR), Super Famicom Mini | `clover-canoe-shvc` (.sfrom, .sfc, .smc) | `usr/share/ui/snes-usa`, `snes-eur`, `shvc` |
| SEGA | Mega Drive / Genesis Mini (USA, EUR, JPN, Asia) | `m2engage` (.bin) | none known |

The targets are decided in this order: the Consoles buttons on the package, then a `Consoles:` line in the readme, then the contents (UI folders used, stock emulators called), and otherwise all consoles. When a package is limited to some consoles, `Consoles:` is written into its readme so the Mod Hub shows it.

Checks against the targets:

- Files or scripts that only work on a console the package isn't set for (for example `clover-ui` files in a SNES-only theme).
- Themes set for a console they have no menu files for, and themes covering only some regions of a console family.
- Games whose stock emulator doesn't exist on the target, or can't open the ROM type. Games that launch through a RetroArch core are noted as needing RetroArch and that core.
- Programs built for a PC (x86) or anything other than 32-bit ARM.

### Package ID and renaming

A package's file name is its **Package ID**, editable at the top of each package: `yourname.package`, for example `dna64.snes9x-theme.hmod`. IDs are lowercase letters, digits and hyphens in two or more dot-separated parts, with no underscores (Hakchi2 CE adds `_1`, `_2`… to a name already in `user_mods`, so a trailing `_N` is never part of an ID). The first part is your namespace; extra parts, like `dna64.snes9x.core`, are up to you.

A package without one gets a warning and a suggested ID built from its readme's Creator and Name, with a button to use it. The central repository requires an ID; your own Mod Hub site doesn't. Games are named the same way: Hakchi2 CE takes a game's code from the `CLV-X-XXXXX.desktop` file inside the `.clvg`, not from the archive's name.

Files inside a package can be renamed or moved from the Files tab by typing a new path.

## Publish

Everything here is on the **Publish** tab. Connect your GitHub account once at the top; it's used for GitHub Pages and for central-repository submissions. Each package is checked before it goes anywhere.

### To your own GitHub Pages site

Under **Your own Mod Hub site** choose **GitHub Pages**, enter a repository you own (for example `you/hmods`; create it on GitHub first, it can be empty) and the branch, and click **Publish to GitHub Pages**. The tool commits the whole repository site in one commit:

- Only `.repo/`, `hmods/`, `games/`, `.nojekyll`, `CNAME` and the generated `index.html` are written. Your own README, licence, or a hand-made `index.html` stay as they are.
- Packages you removed from the list are deleted from `hmods/` and `games/`.
- Unchanged files aren't uploaded again, and publishing with no changes makes no commit.
- A central repository can never be the target: the default one, the one entered under **Central repository**, or any repository whose `repo.json` lists `admins`. The tool refuses before writing anything. Packages reach a central repository only by pull request.
- A branch that doesn't exist yet (for example `gh-pages`) starts its own history holding only the site.

The first time, turn Pages on in the repository's **Settings → Pages**: "Deploy from a branch", your branch, `/ (root)`. The tool does this itself if the token has the `repo` scope.

**Your own domain.** Enter it under **Custom domain**. The tool writes the `CNAME` file and uses the domain for every download link. At your domain provider, add a CNAME record pointing it to `<you>.github.io`.

**The token** needs the `public_repo` scope (classic), or a fine-grained token with Contents: read and write on that repository. It's sent only to `api.github.com` and kept only in that browser tab unless you tick **Remember on this device**.

### To any other web host

Under **Your Mod Hub site** choose **My own web host**, enter the address the files will live at, and click **Download repository**. Unzip it and upload everything, including the hidden `.repo` folder, to that address. A browser can't upload to a web host by itself, so this step is manual.

### To a central repository, by pull request

Under **Central repository**, the MMC Central Repository (`DNA64/ModHubRepo`) is filled in; enter another `owner/name` to submit elsewhere. Every package is listed; click **Check** on one, then **Submit for review**. The tool forks the central repository into your account (or uses a branch if you can write to it), adds the package and opens the pull request. It checks the same rules the central repository's CI does first, so a submission that would be rejected never becomes a pull request. The one exception is a game whose code another game already uses; only CI sees every game, so that's reported on the pull request.

## Run a central repository

`central-repo-template/` is a complete central repository; it is what [DNA64/ModHubRepo](https://github.com/DNA64/ModHubRepo) is built from. To run another one, copy it into a new GitHub repository and follow its README. In short:

```
repo.json                    title, description, admins, optional siteUrl, maxPackageMB
namespaces.json              optional: extra reserved words, namespaces granted by hand
packages/<file>.hmod|.clvg   each package exactly as Hakchi2 CE downloads it
packages/<file>.json         { "version": "1.2.0", "maintainers": [{ "login": "alice", "id": 12345 }] }
.github/workflows/check.yml  checks every pull request
.github/workflows/publish.yml rebuilds the Mod Hub site on gh-pages after each merge
```

The checks (`ci/check-pr.mjs`, using `src/central.js`) enforce:

- Every package passes this tool's checks with no errors, is a plain tar.gz named the way Hakchi2 CE names it, and stays under the size limit.
- Mods have a `Version` in their readme, matching the `.json`.
- Updates must raise the version.
- Only a package's maintainers or an admin can update it, and a new package must list its submitter. Admins come from `repo.json` on the target branch, so a pull request can't make itself an admin.
- Maintainers are matched by numeric GitHub user ID when the `.json` records one (Mod Hub Studio always does), so a login someone renamed away from and a stranger re-registered gets nothing. Plain `"login"` entries from older files still match by login. Each entry must be a valid GitHub username.
- Listing anyone besides the submitter on a new package, or any change to an existing package's maintainers, is listed under **Needs admin approval**.
- The check runs on `pull_request_target`, so GitHub uses `check.yml` from the target branch and a pull request can't edit its own check. The pull request's files are only read, never run.
- Removing a package is only a request: only its maintainers can ask, and the check lists every removal under **Needs admin approval** so the owner decides by merging or closing.
- Only files in `packages/` may change, except by admins.
- Every package is named with a Package ID, admins included.
- Namespaces: whoever maintains a package in a namespace owns it, and `namespaces.json` can grant one by hand. The first package in a new namespace is listed under **Needs admin approval** in the check report. Reserved words (`theme`, `core`, `snes9x`, `retroarch` and others, plus any in `namespaces.json`) can't be namespaces. `dna64`, `dna-64` and `dna_64` are the same namespace. Someone else's namespace can't be a part of a new ID (`snes9x.dna64`); inside a part (`you.dna64-fix`) it's listed for approval.
- No two games share a game code, compared without case.

The workflows run this repository's code at a ref you choose (`PUBLISHER_REPO` and `PUBLISHER_REF` at the top of each workflow), so pin a tag.

## What it checks

The rules come from hakchi's source code, not from convention:

- `mod/hakchi/rootfs/etc/preinit.d/b0030_package`: `pack_install` and `transfer_path`
- `mod/hakchi/rootfs/etc/preinit`: `source_parts`, which runs `b????_*` and `p????_*` scripts
- hakchi2-CE `hakchi_gui/Hmod/*.cs` and `ModHub/Repository/Repository.cs`

| Check | Why it matters |
|---|---|
| Wrapper folder around everything | The package root is copied to `/`, so files land in `/<folder>/…` and CE can't find the readme |
| `var/lib/hakchi/rootfs/` prefix | hakchi adds that itself, so including it doubles the path |
| `Usr/`, `Etc/` capitalisation | The console filesystem is case-sensitive |
| Unknown `usr/share/ui/<x>` folder | Only `snes-usa`, `snes-eur`, `shvc`, `hvc` (and `clover-ui` on NES) are read |
| preinit names | Only `b????_*` / `p????_*` directly in `etc/preinit.d` run |
| preinit without final newline | Scripts are concatenated, so the last line merges with the next script |
| `exit` in preinit, install, uninstall or transfer | They're sourced into a shared shell, so `exit` aborts everything after |
| install not ending in `return` | A failing last command makes hakchi skip copying your files |
| CRLF in `#!` scripts outside preinit | `/bin/sh\r` is "not found" |
| Executables outside bin, sbin, usr/bin, usr/sbin, etc/init.d | hakchi only chmods those folders |
| Nested `.hmod`, root-level `.txt`/`.md` | Skipped or deleted by `pack_install` |
| Bad file-name characters, blacklisted names | CE renames them; hakchi refuses blacklisted names |
| Name isn't a Package ID | Required by the central repository; a warning elsewhere |
| Front matter not at the very top | CE ignores Name, Creator and Version |

### .clvg games

Hakchi2 CE extracts a `.clvg` and imports the `.desktop` file at its top level (`Tasks/AddGamesTask.cs`). The tool checks for exactly one top-level `.desktop` with `Exec=` and `Name=`, a `CLV-X-XXXXX` code, cover art, and no wrapper folder. Games are published under `games/` in the repository.

## Packing

The tool writes a gzip tar owned by root:root. Files in exec folders and marked executables get mode 755; everything else gets 644. The readme is regenerated as `readme.md` from the editor.

## Repository export

The zip is laid out like this:

```
hmods/<name>.hmod
games/<name>.clvg
.repo/pack.tgz              read by Hakchi2 CE's Mod Hub
.repo/list                  read by `hmod rlist` on the console
.repo/<name>.hmod/link      read by `hmod rinstall`
.repo/<name>.hmod/md5, sha1, readme.md
.repo/readme.md
.nojekyll                   lets GitHub Pages serve .repo
index.html                  human-readable listing
HOSTING.md
```

## Develop

Requires Node.js 20 or newer (22 or higher recomended).

```
npm install
npm test          # runs the test suite
npm run build     # rebuilds dist/index.html from src/
```

The tests build every fixture package in memory (`test/helpers.js`), so they need no sample files, network access or other repositories. They cover the tar and gzip code, readme parsing, each validation rule and fix, mod/game detection, nested archives, console targets, packing and the repository export, including the exact patterns Hakchi2 CE uses to read `pack.tgz`.

Publishing and submitting are tested against `test/fake-github.js`, an in-memory stand-in for the parts of the GitHub API the tool uses, so the tests never touch real GitHub. The central-repository scripts in `ci/` are run the way the workflows run them.

`dist/index.html` is committed so people can download the tool without building it. Rebuild and commit it with any change to `src/`; CI fails if it is out of date.

The built page loads React, ReactDOM, JSZip and SparkMD5 from cdnjs, and its fonts from Google Fonts, so it needs an internet connection when it opens.

## Source layout

| File | Contents |
|---|---|
| `src/rules.js` | Validation rules, fixes, install destinations, file modes |
| `src/targets.js` | NES / SNES / SEGA targets and their checks |
| `src/model.js` | Importing archives and folders, mod/game detection, renaming |
| `src/tar.js` | ustar reader and writer, gzip |
| `src/readme.js` | Front matter parser, same regex as Hakchi2 CE |
| `src/pack.js` | `.hmod` / `.clvg` packing |
| `src/repo.js` | Repository export |
| `src/github.js` | GitHub API client (commits through the Git database API) |
| `src/publish.js` | Publishing to GitHub Pages, custom domains |
| `src/packageid.js` | Package ID format, namespaces, reserved words, suggested IDs |
| `src/central.js` | Central repository rules: versions, maintainers, namespaces, game codes, package checks |
| `src/submit.js` | Submitting a package by pull request |
| `ci/` | Scripts the central repository's workflows run |
| `central-repo-template/` | A ready-to-copy central repository |
| `src/examples.js` | The two example packages shown on first open |
| `src/App.jsx`, `src/styles.css` | Interface |
| `test/` | Test suite (`node --test`) |
| `build.mjs` | Bundles `src/` into `dist/index.html` |
