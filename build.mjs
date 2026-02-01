import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parse, compileScript, compileTemplate, rewriteDefault } from '@vue/compiler-sfc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');

function rewriteVueNamedImports(code) {
	return code.replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/g, (_match, spec) => {
		const entries = spec
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const aliasMatch = part.split(/\s+as\s+/i).map((s) => s.trim()).filter(Boolean);
				if (aliasMatch.length === 2) {
					return { original: aliasMatch[0], local: aliasMatch[1] };
				}
				return { original: part, local: part };
			});
		const lines = entries.map(({ original, local }) => {
			if (original === 'defineComponent') {
				return `const ${local} = (...args) => (window.Vue && window.Vue.defineComponent ? window.Vue.defineComponent(...args) : args[0]);`;
			}
			return `const ${local} = (...args) => window.Vue.${original}(...args);`;
		});
		return lines.join('\n');
	});
}

const vueSfcPlugin = {
	name: 'vue-sfc',
	setup(build) {
		build.onLoad({ filter: /\.vue$/ }, async (args) => {
			const source = await fs.promises.readFile(args.path, 'utf8');
			const { descriptor } = parse(source, { filename: args.path });
			const id = crypto.createHash('sha256').update(args.path).digest('hex').slice(0, 8);

			let scriptCode = 'const __sfc__ = {};';
			let bindingMetadata = undefined;
			const scriptLang = (descriptor.scriptSetup && descriptor.scriptSetup.lang) || (descriptor.script && descriptor.script.lang) || '';
			const parserPlugins = scriptLang === 'ts' || scriptLang === 'tsx' ? ['typescript'] : [];
			if (descriptor.scriptSetup) {
				const compiled = compileScript(descriptor, { id });
				bindingMetadata = compiled.bindings;
				scriptCode = rewriteDefault(compiled.content, '__sfc__', parserPlugins);
			} else if (descriptor.script) {
				scriptCode = rewriteDefault(descriptor.script.content, '__sfc__', parserPlugins);
			}
			scriptCode = rewriteVueNamedImports(scriptCode);

			let templateCode = '';
			if (descriptor.template && descriptor.template.content.trim()) {
				const compiledTemplate = compileTemplate({
					source: descriptor.template.content,
					filename: args.path,
					id,
					compilerOptions: {
						mode: 'function',
						runtimeGlobalName: 'Vue',
						hoistStatic: false,
						bindingMetadata
					}
				});
				const importRegex = /^import\s*\{([^}]+)\}\s*from\s*["']vue["'];?/m;
				const constRegex = /^const\s*\{([^}]+)\}\s*=\s*Vue;?/m;
				const importMatch = compiledTemplate.code.match(importRegex);
				const constMatch = compiledTemplate.code.match(constRegex);
				const helperList = (importMatch || constMatch) ? (importMatch ? importMatch[1] : constMatch[1]).trim() : '';
				templateCode = compiledTemplate.code
					.replace(importRegex, '')
					.replace(constRegex, '')
					.replace(/^return function render/m, 'function render')
					.replace(/^export function render/m, 'function render')
					.replace(/^export const render/m, 'const render');
				if (helperList) {
					templateCode = templateCode.replace(/function render\(([^)]*)\)\s*\{/, (match) => {
						return `${match}\n  const {${helperList}} = window.Vue;\n`;
					});
				}
				templateCode += '\n__sfc__.render = render;';
			}

			const contents = `${scriptCode}\n${templateCode}\nexport default __sfc__;\n`;
			return { contents, loader: 'ts' };
		});
	}
};

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
	plugins: [vueSfcPlugin, cssMinifyPlugin],
	loader: {
		'.css': 'text', // Tell esbuild to load CSS files as text so they're bundled into the JS
		'.vue': 'ts'
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
