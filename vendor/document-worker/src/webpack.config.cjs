// document-worker's own webpack configuration, with Anagram's entry in place of Zotero's.
// Copied into the pinned checkout as anagram/webpack.config.cjs by scripts/documentWorker.mjs.
const path = require('path');
const webpack = require('webpack');
const base = require('../webpack.config.cjs');

const checkout = path.join(__dirname, '..');

module.exports = {
	...base,
	entry: ['./anagram/worker.js'],
	output: {
		path: path.join(__dirname, '..', 'build'),
		filename: 'anagram-worker.js',
		publicPath: '/',
		clean: false,
		globalObject: 'this',
	},
	// Built from the pinned sources alone, never from an earlier build's cache.
	cache: false,
	plugins: [
		...base.plugins,
		// webpack writes `import.meta.url` as the module's absolute file: URL, a path on the
		// build machine. This is the same URL rooted at the checkout instead: still a file: URL,
		// so the bundled code takes the branches it took before (onnxruntime-web tests for one).
		// Nothing is loaded from it: pdf.js's decoders and the ONNX runtime are handed their
		// WebAssembly through the data provider (worker.js).
		new webpack.DefinePlugin({
			'import.meta.url': webpack.DefinePlugin.runtimeValue(({ module }) => JSON.stringify(
				`file:///document-worker/${path.relative(checkout, module.resource).split(path.sep).join('/')}`)),
		}),
	],
};
