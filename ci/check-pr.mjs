#!/usr/bin/env node
// Checks a pull request to a central hmod repository.
//   node ci/check-pr.mjs --base <dir> --head <dir> --author <login> [--summary <file>]
// --base is the target branch checked out, --head the pull request. The admin
// list comes from the base branch, so a pull request can't make itself an admin.
import fs from 'node:fs';
import path from 'node:path';
import { args, need, loadPackages, listFiles, readJson } from './lib.mjs';
import { checkSubmission, reportMarkdown, PACKAGES_DIR, DEFAULT_MAX_MB } from '../src/central.js';

const opts = args();
need(opts, 'base', 'head', 'author');

const config = readJson(path.join(opts.base, 'repo.json'));
const baseFiles = new Map(listFiles(opts.base).map((p) => [p, fs.readFileSync(path.join(opts.base, p))]));
const headFiles = new Map(listFiles(opts.head).map((p) => [p, fs.readFileSync(path.join(opts.head, p))]));
// A package is packages/<name>.hmod|.clvg plus its .json; anything else that
// changed (here or elsewhere) is reported for review.
const isPackageFile = (p) => new RegExp(`^${PACKAGES_DIR}/[^/]+\\.(hmod|clvg)(\\.json)?$`, 'i').test(p) || p === `${PACKAGES_DIR}/.gitkeep`;
const otherChanges = [...new Set([...baseFiles.keys(), ...headFiles.keys()])]
  .filter((p) => !isPackageFile(p))
  .filter((p) => !baseFiles.has(p) || !headFiles.has(p) || !baseFiles.get(p).equals(headFiles.get(p)))
  .sort();

const result = await checkSubmission({
  before: loadPackages(opts.base),
  after: loadPackages(opts.head),
  author: opts.author,
  admins: config.admins || [],
  maxMB: Number(config.maxPackageMB) || DEFAULT_MAX_MB,
  otherChanges,
});

const report = reportMarkdown(result, opts.author);
process.stdout.write(report);
if (opts.summary) fs.appendFileSync(opts.summary, report);
process.exit(result.errors.length ? 1 : 0);
