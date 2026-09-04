'use strict';

/**
 * Ad-hoc code-sign the macOS app after packing.
 *
 * An Apple-Silicon app with NO signature is treated by macOS as damaged/malware and
 * moved to Trash — the harshest Gatekeeper verdict. An ad-hoc signature (a real
 * signature with no Apple identity behind it — free, no developer account) downgrades
 * that to the normal "unidentified developer" prompt, which the user can allow once via
 * System Settings ▸ Privacy & Security, or by clearing the download quarantine flag.
 * Paid notarization later removes the prompt entirely, but is not required to run.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return; // Windows/Linux: nothing to do
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`  ad-hoc signed ${appName}`);
};
