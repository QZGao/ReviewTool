import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/main.ts'],
  outfile: 'dist/bundled.js',
  bundle: true,
  format: 'iife',
  charset: 'utf8',
  target: ['es2017'],
  minify: false,
  sourcemap: false,
  banner: { js: `// Main page: [[User:SuperGrey/gadgets/ReviewTool]]
// <nowiki>` },
  footer: { js: '// </nowiki>' },
  logLevel: 'info'
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
