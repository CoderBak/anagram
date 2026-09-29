import { browser } from "#imports";

export const FILE_ORIGIN = "file:///*";

export interface FileAccess {
  granted: boolean;
  allowed: boolean;
}

const runtime = browser.runtime as typeof browser.runtime & { getBrowserInfo?: () => Promise<unknown> };

export async function getFileAccess(): Promise<FileAccess> {
  const granted = await browser.permissions.contains({ origins: [FILE_ORIGIN] }).catch(() => false);
  const allowed = await browser.extension.isAllowedFileSchemeAccess().catch(() => false);
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
