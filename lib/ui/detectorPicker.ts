import { prependActionIcon } from "./actionIcon";
import { defaultRelease, detectorRevisionUrl, type ReleaseRef, type DetectorRelease } from "../detectorReleases";
import { requestComponent, type ComponentReply } from "../backend/nativeClient";
import { t } from "../i18n";
import { browser } from "#imports";
import { formatSize } from "./size";

async function catalog<T>(ref?: ReleaseRef): Promise<T> {
  const reply = await browser.runtime.sendMessage({ action: "detectorCatalog", ref });
  if (!reply?.ok) throw new Error("Catalog unavailable");
  return reply.value as T;
}
export function mountDetectorPicker(host: HTMLElement) {
  const label = document.createElement("label");
  label.htmlFor = "detector-release";
  label.textContent = t("detectorLabel");
  const select = document.createElement("select");
  select.id = label.htmlFor;
  select.className = "select";
  const choice = document.createElement("div");
  choice.className = "detector-choice";
  const currentName = document.createElement("a");
  currentName.target = "_blank";
  currentName.rel = "noopener noreferrer";
  currentName.className = "detector-name";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className="btn";
  refresh.dataset.variant="ghost";
  refresh.dataset.size="sm";
  refresh.classList.add("check-models", "icon-action");
  refresh.title = t("detectorCheck");
  refresh.setAttribute("aria-label", refresh.title);
  prependActionIcon(refresh, "refresh");
  const install = document.createElement("button");
  install.type = "button";
  install.className="btn";
  const note = document.createElement("span");
  note.setAttribute("role", "status");
  choice.append(select, currentName);
  host.append(label, choice, refresh, install, note);
  let active: ReleaseRef = defaultRelease,
    refs: ReleaseRef[] = [active],
    resolved: DetectorRelease | null = null;
  let busy = false,
    loading = false,
    connected = false,
    generation = 0;
  const key = (r: ReleaseRef) => r.release + "@" + r.revision;
  function options(prefer: string) {
    select.replaceChildren(
      ...refs.map(
        (r) =>
          new Option(
            refs.some((x) => x.release === r.release && x.revision !== r.revision)
              ? r.release + " (" + r.revision.slice(0, 7) + ")"
              : r.release,
            key(r),
          ),
      ),
    );
    select.value = refs.some((r) => key(r) === prefer) ? prefer : key(refs[0]!);
  }
  function paint() {
    refresh.disabled = loading;
    const single = refs.length === 1;
    select.hidden = single;
    select.disabled = loading || single;
    const selected = refs.find(r => key(r) === select.value) ?? active;
    currentName.href = detectorRevisionUrl(selected.revision);
    currentName.textContent = single ? selected.release : t("detectorFiles");
    currentName.title = t("detectorFiles");
    install.hidden = !resolved || key(resolved) === key(active);
    install.disabled = !connected || busy || loading;
    if (resolved)
      install.textContent = t(
        "detectorInstall",
        formatSize(resolved.files.reduce((a, f) => a + f.size_bytes, 0)),
      );
  }
  async function choose() {
    const current = ++generation;
    resolved = null;
    note.textContent = "";
    paint();
    const ref = refs.find((r) => key(r) === select.value);
    if (!ref || key(ref) === key(active)) return;
    try {
      const release = await catalog<DetectorRelease>(ref);
      if (current === generation) resolved = release;
    } catch {
      if (current === generation) note.textContent = t("detectorIncompatible");
    }
    paint();
  }
  select.addEventListener("change", () => void choose());
  refresh.addEventListener("click", async () => {
    loading = true;
    paint();
    note.textContent = t("detectorChecking");
    try {
      const found = await catalog<ReleaseRef[]>();
      refs = found.some((r) => key(r) === key(active)) ? found : [active, ...found];
      options(found.length ? key(found[0]!) : key(active));
      await choose();
      if (refs.length === 1) note.textContent = t("detectorCurrent");
    } catch {
      note.textContent = t("detectorCatalogUnavailable");
    } finally {
      loading = false;
      paint();
    }
  });
  install.addEventListener("click", async () => {
    if (!resolved) return;
    loading = true;
    paint();
    try {
      const reply = await requestComponent("models.select", { release: resolved });
      if (reply.kind === "ok") {
        update(reply);
        note.textContent = "";
      } else note.textContent = reply.message || t("componentFailed");
    } catch {
      note.textContent = t("componentFailed");
    } finally {
      loading = false;
      paint();
    }
  });
  function update(reply: ComponentReply) {
    connected = reply.kind === "ok";
    if (reply.kind === "ok") {
      const s = reply.snapshot;
      busy = ["starting", "loading", "downloading", "benchmarking", "updating", "uninstalling"].includes(
        s.state,
      );
      if (s.settings?.release && s.settings.revision) {
        const next = { release: s.settings.release, revision: s.settings.revision };
        if (key(next) !== key(active)) {
          active = next;
          if (!refs.some((r) => key(r) === key(next))) refs.unshift(next);
          options(key(next));
          resolved = null;
        }
      }
    }
    paint();
  }
  options(key(active));
  paint();
  return update;
}
