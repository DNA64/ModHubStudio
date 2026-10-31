#!/usr/bin/env node
// Checks a pull request to a central hmod repository.
//   node ci/check-pr.mjs --base <dir> --head <dir> --author <login> [--author-id <id>] [--summary <file>]
// --author-id is the numeric GitHub user ID of the pull request's author; with
// it, maintainers are matched by ID, so a renamed-away login can't be reused.
// --base is the target branch checked out, --head the pull request. The admin
// list and namespaces.json come from the base branch, so a pull request can't
// make itself an admin or grant itself a namespace.
import fs from 'node:fs';
import path from 'node:path';
import { args, need, loadPackages, listFiles, readJson } from './lib.mjs';
import { checkSubmission, reportMarkdown, parseNamespaces, PACKAGES_DIR, DEFAULT_MAX_MB, NAMESPACES_FILE } from '../src/central.js';

const opts = args();
need(opts, 'base', 'head', 'author');

const config = readJson(path.join(opts.base, 'repo.json'));
const nsFile = path.join(opts.base, NAMESPACES_FILE);
const namespaces = parseNamespaces(fs.existsSync(nsFile) ? fs.readFileSync(nsFile, 'utf8') : null);
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
  author: opts['author-id'] ? { login: opts.author, id: Number(opts['author-id']) } : opts.author,
  admins: config.admins || [],
  maxMB: Number(config.maxPackageMB) || DEFAULT_MAX_MB,
  otherChanges,
  namespaces,
});

const report = reportMarkdown(result, opts.author);
process.stdout.write(report);
if (opts.summary) fs.appendFileSync(opts.summary, report);
process.exit(result.errors.length ? 1 : 0);
