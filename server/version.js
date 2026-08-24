'use strict';

/**
 * One source of truth for the running version: package.json. The git commit is
 * looked up once at startup when it is available, which makes a bug report from
 * a party ("we were on 1.4.0+bede64a") answerable.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { version } = require('../package.json');

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return null; // downloaded as a zip, or git is not installed — not a problem
  }
}

const commit = gitCommit();

module.exports = {
  version,
  commit,
  /** "1.5.0 (bede64a)" — what to show a human. */
  label: commit ? `${version} (${commit})` : version,
};
