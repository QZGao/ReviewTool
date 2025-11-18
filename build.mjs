import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const watch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: [path.join(__dirname, 'src', 'main.ts')],
    outfile: path.join(__dirname, 'dist', 'bundled.js'),
    bundle: true,
    format: 'iife',
    charset: 'utf8',
    target: ['es2017'],
    minify: true,
    sourcemap: false,
    // Tell esbuild to load CSS files as text so they're bundled into the JS
    loader: {
        '.css': 'text'
    },
    banner: {
        js: `// Main page: [[User:SuperGrey/gadgets/ReviewTool]]
// <nowiki>`
    },
    footer: {js: '// </nowiki>'},
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
