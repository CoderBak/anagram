// entrypoints/reader/viewer.ts — the pages themselves, drawn by pdf.js.
//
// Anagram must never change what people really see: it annotates the original, it does not
// replace or reformat it. So the reader is a plain pdf.js viewer — the real pages, with
// the real fonts, figures and mathematics — and everything of ours sits OVER them.
//
// It is deliberately not pdf.js's own PDFViewer component, and it virtualizes only the
// PIXELS. Each page gets a box sized from its viewport, a <canvas> drawn lazily (and
// released again when the reader has scrolled well past it, so a 300-page book stays
// bounded), and a text layer built EAGERLY and left in the DOM for the life of the
// document. Text layers are cheap — absolutely positioned transparent spans — and leaving
// them in place is the whole point: browser find works across the document, and every
// paragraph's text nodes are stable nodes that never go away, which is what lets the
// ordinary pipeline (viewport-first scoring, prefetch, the triage panel, jump-to-flagged,
// marks, chips) run over a PDF exactly as it runs over a web page.
//
// ZOOM changes one CSS variable. pdf.js sizes every layer in --total-scale-factor units
// and places every span as a percentage of the page box, so nothing is rebuilt and no span
// moves house; only the canvases are drawn again, at the new scale.
import type { PdfPage, PageRender } from "../../lib/pdf/extract";
import { MARK_ATTR } from "../../lib/types";
import { createLogger } from "../../lib/log";

const log = createLogger("reader/viewer");

/** Canvas is drawn while the page is within this much of the viewport. */
const RENDER_MARGIN = "1200px 0px";
/** …and its bitmap is let go once it is this far outside, which bounds the memory. */
const KEEP_MARGIN = "3000px 0px";
/**
 * Device pixels per CSS pixel, capped. A 3× screen at 200 % would ask for nine times the
 * bitmap of a 1× screen at 100 %, and past 2× nobody can tell a page of text apart.
 */
const MAX_PIXEL_RATIO = 2;
/**
 * And a hard ceiling on one canvas, in device pixels. Chromium refuses a canvas over
 * about 2^28 pixels outright and a large one costs four bytes each; an A4 page at 400 %
 * on a 2× screen is already 33 M, so this is where a page stops getting sharper and
 * starts merely getting expensive.
 */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

/**
 * One press of − or + multiplies the zoom by this. A ladder of fixed stops was worse: the
 * view opens at whatever fits the window (1.75 for an A4 page in a 1100 px window), and
 * the next stop above that was half a per cent away. A ratio always moves.
 */
const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
/** Room left beside the widest page when the view is fitted to the window's width. */
const FIT_PADDING = 32;

/** One page on screen: its box, the layers over it, and the spans of its text runs. */
export interface PageView {
  n: number;
  /** The page box. Everything of this page is inside it, in its coordinate system. */
  box: HTMLElement;
  /** pdf.js's text layer: the document's own text, transparent, over the drawing. */
  layer: HTMLElement;
  /** Where this page's chips go — over the text layer, outside its selection. */
  chips: HTMLElement;
  /** The span pdf.js made for each item of the page's text runs, in that order. */
  spans: (HTMLElement | undefined)[];
  width: number;
  height: number;
}

export interface Viewer {
  /** Add a page at the end. Its canvas draws itself when it comes near the viewport. */
  add(page: PdfPage): Promise<PageView>;
  view(n: number): PageView | undefined;
  /** The page whose text layer this is — how a chip finds the page it belongs to. */
  pageOf(layer: Element): PageView | undefined;
  /** Current zoom, as a fraction (1 = the page's own size). */
  scale(): number;
  setScale(scale: number): void;
  /** The scale at which the widest page fills the window, and follow the window from now on. */
  fitWidth(): void;
  /** One stop in (+1) or out (−1) of the zoom ladder. */
  step(direction: 1 | -1): void;
  /** Called whenever the zoom changed, for the percentage in the bar. */
  onScale(fn: (scale: number) => void): void;
  /** Canvases that currently hold a bitmap — the memory bound the perf suite asserts. */
  liveCanvases(): number;
  destroy(): void;
}

export function createViewer(container: HTMLElement): Viewer {
  const views = new Map<number, PageView>();
  const byLayer = new Map<Element, PageView>();
  const canvases = new WeakMap<HTMLElement, HTMLCanvasElement>();
  const jobs = new WeakMap<HTMLElement, PageRender>();
  /** Boxes whose canvas should hold pixels right now. */
  const wanted = new Set<HTMLElement>();
  let scale = 1;
  /** The zoom follows the window's width until the reader asks for a number of their own. */
  let fitting = true;
  let listener: ((scale: number) => void) | null = null;

  container.style.setProperty("--scale-factor", String(scale));

  const near = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const box = e.target as HTMLElement;
        if (!e.isIntersecting) continue;
        wanted.add(box);
        void draw(box);
      }
    },
    { root: null, rootMargin: RENDER_MARGIN, threshold: 0 },
  );

  const keep = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) continue;
        const box = e.target as HTMLElement;
        wanted.delete(box);
        release(box);
      }
    },
    { root: null, rootMargin: KEEP_MARGIN, threshold: 0 },
  );

  /** Give a far-away page's canvas its memory back. A zero-sized canvas holds nothing. */
  function release(box: HTMLElement): void {
    jobs.get(box)?.cancel();
    jobs.delete(box);
    const canvas = canvases.get(box);
    if (!canvas || canvas.width === 0) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  /** How many device pixels one CSS pixel of this page is worth, under both ceilings. */
  function pixelScale(view: PageView): number {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const area = view.width * scale * view.height * scale * dpr * dpr;
    return area > MAX_CANVAS_PIXELS ? dpr * Math.sqrt(MAX_CANVAS_PIXELS / area) : dpr;
  }

  async function draw(box: HTMLElement): Promise<void> {
    const view = views.get(Number(box.dataset.page));
    const page = sources.get(box);
    const canvas = canvases.get(box);
    if (!view || !page || !canvas) return;
    const px = pixelScale(view);
    const width = Math.max(1, Math.floor(view.width * scale * px));
    const height = Math.max(1, Math.floor(view.height * scale * px));
    if (canvas.width === width && canvas.height === height) return; // already this sharp
    jobs.get(box)?.cancel();
    canvas.width = width;
    canvas.height = height;
    const job = page.render(canvas, scale, px);
    jobs.set(box, job);
    try {
      await job.promise;
    } catch (e) {
      // A cancelled drawing is the ordinary way a page that scrolled away ends.
      if ((e as { name?: string })?.name !== "RenderingCancelledException") {
        log.warn("page", view.n, "could not be drawn", e);
      }
      return;
    }
    if (jobs.get(box) === job) jobs.delete(box);
  }

  /** The page each box was built from, so a redraw needs nothing from the caller. */
  const sources = new WeakMap<HTMLElement, PdfPage>();

  async function add(page: PdfPage): Promise<PageView> {
    const box = document.createElement("div");
    box.className = "page";
    box.dataset.page = String(page.n);
    // pdf.js's own rule: a layer's box is stated in --total-scale-factor units, so the
    // browser resizes it when the variable changes and nothing here has to.
    box.style.width = `calc(var(--total-scale-factor) * ${page.width}px)`;
    box.style.height = `calc(var(--total-scale-factor) * ${page.height}px)`;

    const canvas = document.createElement("canvas");
    // The drawing is the document's own picture of itself; the text layer over it is what
    // a screen reader and a text search read, so the picture says nothing.
    canvas.setAttribute("role", "presentation");
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = 0;
    canvas.height = 0;

    const layer = document.createElement("div");
    layer.className = "textLayer";

    const chips = document.createElement("div");
    chips.className = "chipLayer";
    chips.setAttribute(MARK_ATTR, "host");

    box.append(canvas, layer, chips);
    container.append(box);
    canvases.set(box, canvas);
    sources.set(box, page);

    const view: PageView = {
      n: page.n,
      box,
      layer,
      chips,
      spans: [],
      width: page.width,
      height: page.height,
    };
    views.set(page.n, view);
    byLayer.set(layer, view);
    near.observe(box);
    keep.observe(box);
    // The layer sizes ITSELF: pdf.js's TextLayer calls its own setLayerDimensions on the
    // container, in the same --total-scale-factor units the box above uses, which is what
    // keeps the transparent text on the glyphs at every zoom.
    view.spans = await page.textLayer(layer);
    return view;
  }

  function apply(next: number): void {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (Math.abs(clamped - scale) < 0.0005) return;
    scale = clamped;
    container.style.setProperty("--scale-factor", String(scale));
    // The boxes and the text layers follow the variable by themselves; only the pictures
    // have to be drawn again, and only the ones somebody can see.
    for (const box of wanted) void draw(box);
    listener?.(scale);
  }

  function fitScale(): number {
    const widest = Math.max(...[...views.values()].map((v) => v.width), 1);
    const room = container.clientWidth - FIT_PADDING;
    return room > 0 ? room / widest : 1;
  }

  function fitWidth(): void {
    fitting = true;
    apply(fitScale());
  }

  function step(direction: 1 | -1): void {
    fitting = false;
    // Rounded to whole percents, so the bar reads "175 %" rather than "174.51 %".
    apply(Math.round(scale * (direction === 1 ? ZOOM_STEP : 1 / ZOOM_STEP) * 100) / 100);
  }

  const onResize = (): void => {
    if (fitting) apply(fitScale());
  };
  window.addEventListener("resize", onResize);

  return {
    add,
    view: (n) => views.get(n),
    pageOf: (layer) => byLayer.get(layer),
    scale: () => scale,
    setScale: (s) => {
      fitting = false;
      apply(s);
    },
    fitWidth,
    step,
    onScale: (fn) => {
      listener = fn;
    },
    liveCanvases: () => {
      let n = 0;
      for (const view of views.values()) {
        const canvas = canvases.get(view.box);
        if (canvas && canvas.width > 0 && canvas.height > 0) n++;
      }
      return n;
    },
    destroy: () => {
      near.disconnect();
      keep.disconnect();
      window.removeEventListener("resize", onResize);
      for (const view of views.values()) release(view.box);
      views.clear();
      byLayer.clear();
      wanted.clear();
      container.replaceChildren();
    },
  };
}
