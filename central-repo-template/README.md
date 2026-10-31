# MMC Central Repository for Hakchi2 CE

A shared Mod Hub repository for Hakchi2 CE, at
[github.com/DNA64/ModHubRepo](https://github.com/DNA64/ModHubRepo). Mod and game authors submit
packages by pull request; every pull request is checked automatically, and
merged packages are published to the Mod Hub site.

## Add this repository in Hakchi2 CE

Modules → Mod Hub → Repositories → add:

    https://dna64.github.io/ModHubRepo

(If `siteUrl` in `repo.json` is set to a custom domain, use that instead.)

## Submit a package

The easy way is [Mod Hub Studio](https://github.com/DNA64/ModHubStudio):
open the **Publish** tab, check that **Central repository** says
`DNA64/ModHubRepo` (the default), then click **Check** and **Submit for
review** next to the package. It forks this repository, adds
the package and opens the pull request for you.

Don't use **Publish to GitHub Pages** for this repository. That's for your
own site, and the Studio refuses to publish over a central repository.

By hand, add two files under `packages/` in a pull request:

```
packages/yourname.my-mod.hmod         the package, packed by Mod Hub Studio
packages/yourname.my-mod.hmod.json    the version and who maintains it (below)
```

```json
{
  "version": "1.0.0",
  "maintainers": [{ "login": "your-github-login", "id": 12345 }]
}
```

`id` is your numeric GitHub user ID, shown at
`https://api.github.com/users/your-github-login`. Mod Hub Studio fills it in
for you. Older files may list a plain `"login"` instead, which still works.

## Package IDs

A package's file name is its Package ID, and it never changes once
published. Hakchi2 CE and other packages refer to it by that ID.

- Lowercase letters, digits and hyphens, in two or more parts separated by
  dots: `yourname.my-mod`, or `yourname.snes9x-fast.core` if you like more
  detail. No underscores.
- The first part is your **namespace**. Use the same one for all your
  packages.
- The first package in a new namespace needs an admin's approval; the check
  lists it under **Needs admin approval**. After that the namespace is yours:
  anyone who maintains a package in it can publish more under it, and nobody
  else can.
- Common words (`theme`, `core`, `snes9x`, `retroarch` and others) can't be
  namespaces.
- `dna64`, `dna-64` and `dna_64` count as the same namespace.
- Someone else's namespace can't appear as a part of your ID
  (`snes9x.dna64`). Inside a part (`yourname.dna64-fix`), it's flagged for
  an admin to check.
- Games (`.clvg`) are named the same way. Hakchi2 CE takes the game's code
  from the `CLV-X-XXXXX.desktop` file inside, not from the archive name, and
  each code may only be used by one game here.

## Rules the checks enforce

- Only files in `packages/` may change (admins excepted).
- Each package is a plain tar.gz `.hmod` or `.clvg`, named with a Package ID,
  with no errors from Mod Hub Studio's checks.
- New packages follow the namespace rules above, and no two games share a
  game code.
- Mods carry a `Version` in their readme, matching the `.json` file.
- An update must raise the version above the one already published.
- Only a package's listed maintainers (or an admin) can update it; a new
  package must list the person submitting it.
- Maintainers are matched by GitHub user ID when the `.json` has one, so if
  someone renames their account and a stranger registers the old name, the
  stranger gets nothing.
- Each maintainer is its own entry, with a valid GitHub username (no `@`, no
  commas).
- Listing anyone besides the submitter on a new package, or changing the
  maintainers of an existing one, is listed under **Needs admin approval**.
- Removing a package is only ever a request. Its maintainers can ask, by
  opening a pull request that deletes its `.hmod` and `.json`. The check lists
  it under **Needs admin approval**, and nothing is removed until an admin
  merges it.
- Packages are limited to `maxPackageMB` in `repo.json` (GitHub refuses files
  over 100 MB).

## Removing a package

To ask for a package to be removed, its maintainer opens a pull request that
deletes both `packages/<file>.hmod` and `packages/<file>.json`. The owner
decides: merge to remove it, or close the pull request to keep it.

Give only the owner (or admins) permission to merge, with a branch protection
rule on `main`, so the owner always has the final say.

## Setting up a copy of this repository

1. Create the repository on GitHub from these files.
2. Edit `repo.json`: the title, description, admins, and `siteUrl` if you use
   a custom domain. Change the owners in `.github/CODEOWNERS` to match.
   Optionally list extra reserved words in `namespaces.json`, or grant a
   namespace to people by hand: `"namespaces": { "dna64": ["DNA64"] }`.
3. Merge or push once to `main` so **Publish site** creates the `gh-pages`
   branch, then set Settings → Pages to "Deploy from a branch", `gh-pages`,
   `/ (root)`.
4. Protect `main` with a ruleset: Settings → Rules → Rulesets → New branch
   ruleset, targeting the default branch, with enforcement Active.
   - **Bypass list:** Repository admin, **For pull requests only**. The owner
     can merge their own pull requests (nobody can approve their own), but
     can't push straight to `main` either.
   - Restrict deletions, and block force pushes.
   - Require a pull request: 1 approval, review from Code Owners, dismiss
     stale approvals, and require approval of the most recent push.
   - Require status checks: **check** (it's listed once the check has run on
     a pull request).

   With `* @owner` in `.github/CODEOWNERS`, every pull request needs the
   owner's review, so the owner keeps the final say even when other people
   have write access.

**Check packages** runs on `pull_request_target`, so GitHub always runs the
copy of `check.yml` on `main`. A pull request that edits `check.yml` can't
change or skip its own check; the edit only takes effect once merged. The
pull request's files are read as data and never run.

The checks run code from `PUBLISHER_REPO` at `PUBLISHER_REF` (set at the top
of both workflows). Pin a tag there so a change to the publisher can't change
your rules unexpectedly.
