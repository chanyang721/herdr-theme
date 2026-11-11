import {readFile} from 'node:fs/promises';

// linear-reads.js for a test harness: its herdr imports come from globalThis.__linearReads
// (set per test; a quiet stub otherwise) and alert-model.js from the source tree.
let loads = 0;
export async function linearReadsUrl() {
  const source = (await readFile(new URL('../mods/sixfold-desk/linear-reads.js', import.meta.url), 'utf8'))
    .replace(/import \{([^}]+)\} from 'herdr';/, (_m, names) =>
      `const {${names}} = globalThis.__linearReads ?? {appHome: () => '/home', readTextFile: async () => null, writeTextFile: async () => {}};`)
    .replace("'./alert-model.js'", JSON.stringify(new URL('../mods/sixfold-desk/alert-model.js', import.meta.url).href));
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${loads++}`;
}
