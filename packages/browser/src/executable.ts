import { access, constants } from "node:fs/promises";

/**
 * The Chromium to drive: the one the image installs (`apt chromium`), or a
 * Chrome on a developer's machine. No browser is downloaded: playwright-core
 * drives whatever is already here.
 */
const CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/lib/chromium/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export async function findChromium(configured?: string | null): Promise<string | null> {
  for (const path of configured ? [configured] : CANDIDATES) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Not this one.
    }
  }
  return null;
}
