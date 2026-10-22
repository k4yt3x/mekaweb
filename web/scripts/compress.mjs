// Writes a Brotli and a gzip copy beside each text file of the build, which mekaweb serves to a
// browser that takes them instead of compressing the same files on every request.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = new URL('../dist/', import.meta.url).pathname;
const text = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt']);
const smallest = 1024;

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

let count = 0;
for await (const path of files(root)) {
  if (!text.has(extname(path))) continue;
  const data = await readFile(path);
  if (data.length < smallest) continue;
  await writeFile(
    path + '.br',
    brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
  );
  await writeFile(path + '.gz', gzipSync(data, { level: 9 }));
  count++;
}
console.log(`compressed ${count} files`);
