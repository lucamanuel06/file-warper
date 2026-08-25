import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Strip `com.apple.FinderInfo` from the packed .app before electron-builder
 * signs it.
 *
 * codesign hard-fails on any bundle carrying that attribute:
 *   "resource fork, Finder information, or similar detritus not allowed"
 *
 * It lands on the .app and .framework *directories* (not the executables) when
 * the build tree lives under a file-provider-synced folder such as iCloud
 * Drive — which ~/Documents is by default.
 *
 * Note: a blanket `xattr -cr` does NOT work here. It aborts partway when it
 * hits a protected attribute (`com.apple.fileprovider.fpfs#P`), leaving
 * FinderInfo in place on exactly the directories that matter. Deleting the one
 * attribute by name is reliable.
 *
 * `afterPack` runs after the bundle is assembled and before signing, which is
 * the only correct moment for this.
 */
export default async function afterPack({ appOutDir }) {
  await run('xattr', ['-rd', 'com.apple.FinderInfo', appOutDir]).catch(() => {
    // -rd exits non-zero when no file carries the attribute. That is success.
  });
  console.log(`[after-pack] stripped com.apple.FinderInfo from ${appOutDir}`);
}
