'use strict';

/**
 * Open a URL in whatever browser the machine calls default. Best effort only —
 * a booth that could not raise a browser still runs fine, so a failure here is
 * never worth stopping for.
 */

const { execFile } = require('node:child_process');

const LAUNCHERS = {
  darwin: ['open', []],
  win32: ['cmd', ['/c', 'start', '']],
  linux: ['xdg-open', []],
};

function openInBrowser(url) {
  const launcher = LAUNCHERS[process.platform];
  if (!launcher) return Promise.resolve(false);

  const [command, args] = launcher;
  return new Promise((resolve) => {
    execFile(command, [...args, url], { timeout: 5000 }, (err) => resolve(!err));
  });
}

module.exports = { openInBrowser };
