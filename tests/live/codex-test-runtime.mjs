import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
let pending;
export function codexTestRuntime() {
  return pending ??= (async () => {
    const bundle = await build({ stdin: { contents: "import * as Vue from 'vue'; import { CdxToggleButton, CdxIcon } from '@wikimedia/codex'; window.testCodex = { Vue: { ...Vue, createMwApp: Vue.createApp }, Codex: { CdxToggleButton, CdxIcon } };", resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false });
    return { script: bundle.outputFiles[0].text, style: await readFile('node_modules/@wikimedia/codex/dist/codex.style.css', 'utf8') };
  })();
}
