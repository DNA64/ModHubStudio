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
`DNA64/ModHubRepo` (the default), then click **Check** and **Open pull
request** next to the package. It forks this repository, adds
the package and opens the pull request for you.

By hand, add two files under `packages/` in a pull request:

```
packages/My_Mod.hmod         the package, packed by Mod Hub Studio
packages/My_Mod.hmod.json    { "version": "1.0.0", "maintainers": ["your-github-login"] }
```

## Rules the checks enforce

- Only files in `packages/` may change (admins excepted).
- Each package is a plain tar.gz `.hmod` or `.clvg`, named the way Hakchi2 CE
  names it, with no errors from Mod Hub Studio's checks.
- Mods carry a `Version` in their readme, matching the `.json` file.
- An update must raise the version above the one already published.
- Only a package's listed maintainers (or an admin) can update or remove it;
  a new package must list the person submitting it.
- Packages are limited to `maxPackageMB` in `repo.json` (GitHub refuses files
  over 100 MB).

## Setting up a copy of this repository

1. Create the repository on GitHub from these files.
2. Edit `repo.json`: the title, description, admins, and `siteUrl` if you use
   a custom domain. Change the owners in `.github/CODEOWNERS` to match.
3. Merge or push once to `main` so **Publish site** creates the `gh-pages`
   branch, then set Settings → Pages to "Deploy from a branch", `gh-pages`,
   `/ (root)`.
4. In Settings → Branches, protect `main`: require a pull request, one
   approval, review from code owners, and the **Check packages** status.

The checks run code from `PUBLISHER_REPO` at `PUBLISHER_REF` (set at the top
of both workflows). Pin a tag there so a change to the publisher can't change
your rules unexpectedly.
