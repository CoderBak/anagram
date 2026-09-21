import { browser } from "#imports";
import { browsingOrigins, matchesAny } from "../access/patterns";
import { getFileAccess } from "./fileAccess";
import { safePdfSource } from "./source";

/** Persistent grants only; an incidental activeTab grant never enables automatic routing. */
export async function hasPdfSourceAccess(source: string): Promise<boolean> {
  const url = safePdfSource(source);
  if (!url) return false;
  try {
    if (url.protocol === "file:") {
      const access = await getFileAccess();
      return access.granted && access.allowed;
    }
    return matchesAny(browsingOrigins((await browser.permissions.getAll()).origins), url.href);
  } catch { return false; }
}
