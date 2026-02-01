import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');

const cssMinifyPlugin = {
	name: 'css-minify',
	setup(build) {
		build.onLoad({ filter: /\.css$/ }, async (args) => {
			const text = await fs.promises.readFile(args.path, 'utf8');
			if (!release) {
				return { contents: text, loader: 'text' };
			}
			const result = await esbuild.transform(text, {
				loader: 'css',
				minify: true
			});
			return { contents: result.code, loader: 'text' };
		});
	}
};

const buildOptions = {
	entryPoints: [path.join(__dirname, 'src', 'main.ts')],
	outfile: path.join(__dirname, 'dist', 'bundled.js'),
	bundle: true,
	format: 'iife',
	charset: 'utf8',
	target: ['es2017'],
	minify: release,
	sourcemap: false,
	plugins: [cssMinifyPlugin],
	loader: {
		'.css': 'text' // Tell esbuild to load CSS files as text so they're bundled into the JS
	},
	banner: {
		js: `// [[User:SuperGrey/gadgets/ReviewTool]]
// Repository: https://github.com/QZGao/ReviewTool
// Release: ${pkgJson.version}
// Timestamp: ${new Date().toISOString()}
// <nowiki>`
	},
	footer: { js: '// </nowiki>' },
	logLevel: 'info',
};

(async () => {
	try {
		if (watch) {
			const ctx = await esbuild.context(buildOptions);
			await ctx.watch();
			console.log('[ReviewTool build] Watching for changes...');
		} else {
			await esbuild.build(buildOptions);
			console.log('[ReviewTool build] Build complete');
		}
	} catch (e) {
		console.error('[ReviewTool build] Build failed:', e);
		process.exit(1);
	}
})();
