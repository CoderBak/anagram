// document-worker's own webpack configuration, with Anagram's entry in place of Zotero's.
// Copied into the pinned checkout as anagram/webpack.config.cjs by scripts/documentWorker.mjs.
const path = require('path');
const base = require('../webpack.config.cjs');

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
};
