import { createRequire } from 'node:module';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const destination = new URL('../public/ocr-assets/', import.meta.url);
const packageDirectory = name => dirname(require.resolve(name + '/package.json'));
const tesseract = packageDirectory('tesseract.js');
const workerRequire = createRequire(join(tesseract, 'package.json'));
const core = dirname(workerRequire.resolve('tesseract.js-core/package.json'));
await Promise.all(['', 'core/', 'lang/'].map(folder => mkdir(new URL(folder, destination), { recursive: true })));

await copyFile(join(tesseract, 'dist', 'worker.min.js'), new URL('worker.min.js', destination));
await copyFile(join(packageDirectory('pdfjs-dist'), 'build', 'pdf.worker.min.mjs'), new URL('pdf.worker.min.mjs', destination));
await Promise.all([
  [tesseract, 'LICENSE.md', 'tesseract-license.txt'],
  [core, 'LICENSE', 'tesseract-core-license.txt'],
  [packageDirectory('pdfjs-dist'), 'LICENSE', 'pdfjs-license.txt'],
].map(([directory, source, target]) => copyFile(join(directory, source), new URL(target, destination))));

const runtimes = ['lstm', 'simd-lstm', 'relaxedsimd-lstm'].flatMap(variant =>
  ['.wasm', '.wasm.js'].map(extension => 'tesseract-core-' + variant + extension));
await Promise.all(runtimes.map(name => copyFile(join(core, name), new URL('core/' + name, destination))));

for (const lang of ['ara', 'eng']) {
  const folder = packageDirectory('@tesseract.js-data/' + lang);
  const file = lang + '.traineddata.gz';
  const best = join(folder, '4.0.0_best_int', file);
  const source = await stat(best).then(() => best, () => join(folder, '4.0.0', file));
  await copyFile(source, new URL('lang/' + file, destination));
}
