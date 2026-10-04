// Anagram's entry into Zotero's document-worker: one call, getStructure, in a Web Worker.
// Given a `range` of pages, it reads only those (see `ranged` below).
//
// scripts/documentWorker.mjs copies this file into the pinned checkout as
// anagram/worker.js and bundles it with the worker's own webpack configuration, so the
// import below resolves inside that checkout. Everything the worker reads — the pdf.js
// fork's CMaps, standard fonts and image decoders, the ONNX runtime and the block
// segmentation models — is fetched from the extension by the URLs the reader hands over
// in `roots`; nothing is loaded from the network.
import { getStructure, getPdfManager } from '../src/pdf/index.js';
import { getFullStructure } from '../src/pdf/structure/structure.js';

let roots = null;
const loaded = new Map();

// The worker asks for the plain build's WebAssembly; the extension ships one ONNX Runtime
// binary, the JSPI build the in-browser engine runs (vendor/engine/), which the bundle of
// onnxruntime-web/jspi (anagram/webpack.config.cjs) is built for. `roots.onnx` is that folder.
const ORT_WASM = { 'onnx/ort-wasm-simd-threaded.wasm': 'onnx/ort-wasm-simd-threaded.jspi.wasm' };

function provide(requested) {
	const path = ORT_WASM[requested] ?? requested;
	const slash = path.indexOf('/');
	const root = roots?.[slash < 0 ? path : path.slice(0, slash)];
	if (!root) return Promise.reject(new Error(`no root for ${path}`));
	const url = root + path.slice(slash + 1);
	let pending = loaded.get(url);
	if (!pending) {
		pending = fetch(url).then(async (response) => {
			if (!response.ok) throw new Error(`${path}: ${response.status}`);
			return response.arrayBuffer();
		});
		loaded.set(url, pending);
	}
	return pending;
}

// A PAGE RANGE. Zotero reads a whole document at once and holds every page's glyphs until
// it answers, so what it needs grows with the document: 2.7 GB of the reader's process at its
// peak for 2,445 pages, against 1.4 GB for 813. A longer document is read a range at a time,
// each in a worker of its own (lib/pdf/structureWorker.ts): the document Zotero is handed
// here has only the range's pages, numbered from 0, and what it answers is numbered back into
// the whole document's pages, and its block paths moved past the content of the ranges before
// it (`contentBase`), so that the ranges' contents laid end to end are one structure. What
// Zotero works out over the document as a whole — a page's running heads, a list of
// references — it works out over the range, which is hundreds of pages.

/** Wrap an object so that `overrides` answer first and everything else is the object's own,
 *  its methods called on the object itself. */
function over(target, overrides) {
	return new Proxy(target, {
		get(object, key) {
			if (Object.hasOwn(overrides, key)) return overrides[key];
			const value = Reflect.get(object, key, object);
			return typeof value === 'function' ? value.bind(object) : value;
		},
	});
}

/** The document as Zotero should see it: pages start to end - 1, numbered from 0. A link or
 *  an outline entry to a page outside the range resolves to nothing, as a broken one does. */
function ranged(pdfDocument, start, end) {
	const count = end - start;
	const local = (index) => {
		if (!Number.isInteger(index) || index < start || index >= end) throw new RangeError('page outside the range');
		return index - start;
	};
	const pdfManager = over(pdfDocument.pdfManager, {
		async ensureCatalog(property, args) {
			const value = await pdfDocument.pdfManager.ensureCatalog(property, args);
			if (property === 'getPageIndex') return local(value);
			if (property === 'pageLabels') return Array.isArray(value) ? value.slice(start, end) : value;
			return value;
		},
	});
	const module = over(pdfDocument.module, {
		getPageCharsObjects: (index, ...rest) => pdfDocument.module.getPageCharsObjects(index + start, ...rest),
	});
	return over(pdfDocument, {
		numPages: count,
		pagesCount: count,
		pdfManager,
		module,
		getPage: async (index) => over(await pdfDocument.getPage(index + start), { pageIndex: index }),
	});
}

/** Number a range's answer into the whole document: pages by `start`, block paths (whose first
 *  step is a top-level block) by `contentBase`. */
function shift(structure, start, contentBase) {
	const path = (p) => (Array.isArray(p) && typeof p[0] === 'number' ? [p[0] + contentBase, ...p.slice(1)] : p);
	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		const anchor = node.anchor;
		if (anchor) {
			if (Array.isArray(anchor.pageRects)) anchor.pageRects = anchor.pageRects.map((r) => [r[0] + start, ...r.slice(1)]);
			if (typeof anchor.textMap === 'string') {
				try {
					const runs = JSON.parse(anchor.textMap);
					if (Array.isArray(runs)) {
						for (const run of runs) if (Array.isArray(run) && typeof run[1] === 'number') run[1] += start;
						anchor.textMap = JSON.stringify(runs);
					}
				}
				catch {}
			}
		}
		if (node.previousPart) node.previousPart = path(node.previousPart);
		if (node.nextPart) node.nextPart = path(node.nextPart);
		if (Array.isArray(node.backRefs)) node.backRefs = node.backRefs.map(path);
		if (Array.isArray(node.refs)) node.refs = node.refs.map(path);
		if (Array.isArray(node.content)) node.content.forEach(visit);
	};
	structure.content.forEach(visit);
	return structure;
}

async function rangeStructure(buf, password, range, contentBase, options) {
	const pdfManager = await getPdfManager(buf, password);
	setHandler(pdfManager.pdfDocument);
	const [start, end] = range;
	const structure = await getFullStructure(
		ranged(pdfManager.pdfDocument, start, end),
		() => provide('onnx/ort-wasm-simd-threaded.wasm'),
		(name) => provide(name.includes('/') ? name : name + '/model.onnx'),
		options,
	);
	return shift(structure, start, contentBase);
}

/** What src/pdf/index.js's setHandler gives the fork: its CMaps, standard fonts and image
 *  decoders, through `provide`. (getStructure sets it itself; it is not exported.) */
function setHandler(pdfDocument) {
	const handler = { send() {} };
	handler.sendWithPromise = async (op, data) => {
		if (op === 'FetchBuiltInCMap') return { cMapData: await provide('cmaps/' + data.name + '.bcmap'), isCompressed: true };
		if (op === 'FetchStandardFontData') return provide('standard_fonts/' + data.filename);
		if (op === 'FetchBinaryData') {
			if (data.kind === 'cMapUrl') return provide('cmaps/' + (data.filename.endsWith('.bcmap') ? data.filename : data.filename + '.bcmap'));
			if (data.kind === 'standardFontDataUrl') return provide('standard_fonts/' + data.filename);
			if (data.kind === 'wasmUrl') return provide('wasm/' + data.filename);
			if (data.type === 'cMapReaderFactory') return { cMapData: await provide('cmaps/' + data.name + '.bcmap'), isCompressed: true };
			if (data.type === 'standardFontDataFactory') return provide('standard_fonts/' + data.filename);
			if (data.type === 'wasmFactory') return provide('wasm/' + data.filename);
		}
	};
	pdfDocument.pdfManager._handler = handler;
}

self.onmessage = async (event) => {
	const { id, buf, password, sourceHash, range, contentBase } = event.data;
	if (event.data.roots) roots = event.data.roots;
	try {
		const options = {
			sourceHash,
			onProgress: (progress) => self.postMessage({ id, progress }),
		};
		const structure = range
			? await rangeStructure(buf, password ?? '', range, contentBase ?? 0, options)
			: await getStructure(buf, password ?? '', provide, options);
		self.postMessage({ id, structure });
	}
	catch (error) {
		self.postMessage({ id, error: String(error?.message ?? error) });
	}
};
