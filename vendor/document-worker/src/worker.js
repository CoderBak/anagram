// Anagram's entry into Zotero's document-worker: one call, getStructure, in a Web Worker.
//
// scripts/documentWorker.mjs copies this file into the pinned checkout as
// anagram/worker.js and bundles it with the worker's own webpack configuration, so the
// import below resolves inside that checkout. Everything the worker reads — the pdf.js
// fork's CMaps, standard fonts and image decoders, the ONNX runtime and the block
// segmentation models — is fetched from the extension by the URLs the reader hands over
// in `roots`; nothing is loaded from the network.
import { getStructure } from '../src/pdf/index.js';

let roots = null;
const loaded = new Map();

function provide(path) {
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

self.onmessage = async (event) => {
	const { id, buf, password, sourceHash } = event.data;
	if (event.data.roots) roots = event.data.roots;
	try {
		const structure = await getStructure(buf, password ?? '', provide, {
			sourceHash,
			onProgress: (progress) => self.postMessage({ id, progress }),
		});
		self.postMessage({ id, structure });
	}
	catch (error) {
		self.postMessage({ id, error: String(error?.message ?? error) });
	}
};
