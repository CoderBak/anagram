import { browser } from "#imports";

export const FILE_ORIGIN = "file:///*";

export interface FileAccess {
  granted: boolean;
  allowed: boolean;
}

type BrowserInfo = { name?: string; version?: string };
const runtime = browser.runtime as typeof browser.runtime & { getBrowserInfo?: () => Promise<BrowserInfo> };

/** Firefox before 153 gates files with host access; newer versions have a separate switch. */
export function legacyFirefoxFileAccess(info: BrowserInfo | undefined): boolean {
  const major = Number.parseInt(info?.version ?? "", 10);
  return info?.name === "Firefox" && Number.isFinite(major) && major >= 140 && major < 153;
}

export async function getFileAccess(): Promise<FileAccess> {
  const granted = await browser.permissions.contains({ origins: [FILE_ORIGIN] }).catch(() => false);
  let allowed = await browser.extension.isAllowedFileSchemeAccess().catch(() => false);
  if (!allowed && granted && runtime.getBrowserInfo) {
    const info = await runtime.getBrowserInfo().catch(() => undefined);
    allowed = legacyFirefoxFileAccess(info);
  }
  return { granted, allowed };
}

/** Call directly inside the user's click, before awaiting anything. */
export function requestFileAccess(): Promise<boolean> {
  return browser.permissions.request({ origins: [FILE_ORIGIN] }).catch(() => false);
}

export const needsManualFileSettings = (): boolean => typeof runtime.getBrowserInfo === "function";

/** Firefox forbids extension navigation to about:addons; its UI supplies manual steps. */
export async function openFileAccessSettings(): Promise<boolean> {
  if (needsManualFileSettings()) return false;
  await browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
  return true;
}
