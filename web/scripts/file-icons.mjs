// Writes src/files/file-icons.json from Material Icon Theme's manifest: which icon each file name,
// extension and folder name takes, grouped by icon so the map stays small. Run it after updating
// material-icon-theme, as `npm run icons:generate`.
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../node_modules/material-icon-theme/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('dist/material-icons.json', root), 'utf8'));
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

/** `names`, a map of name to icon, as each icon with its names. */
function byIcon(names) {
  const grouped = {};
  for (const [name, icon] of Object.entries(names)) (grouped[icon] ??= []).push(name);
  for (const list of Object.values(grouped)) list.sort();
  return Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)));
}

// An open folder's icon is its closed one's with `-open`; any that is not is kept apart.
const opened = {};
for (const [name, icon] of Object.entries(manifest.folderNamesExpanded)) {
  if (icon !== `${manifest.folderNames[name]}-open`) opened[name] = icon;
}

// A light theme's icon is the dark one's with `_light`; those that have one are listed.
const light = new Set();
for (const kind of ['fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded']) {
  for (const [name, icon] of Object.entries(manifest.light[kind] ?? {})) {
    const dark = manifest[kind][name];
    if (icon !== `${dark}_light`) throw new Error(`${kind} ${name}: ${icon} is not ${dark}_light`);
    light.add(dark);
  }
}

const icons = {
  version,
  file: manifest.file,
  folder: manifest.folder,
  root: manifest.rootFolder,
  files: byIcon(manifest.fileNames),
  extensions: byIcon(manifest.fileExtensions),
  folders: byIcon(manifest.folderNames),
  opened,
  light: [...light].sort(),
};
await writeFile(
  new URL('../src/files/file-icons.json', import.meta.url),
  JSON.stringify(icons) + '\n',
);
console.log(
  `material-icon-theme ${version}: ${Object.keys(manifest.fileNames).length} file names, ` +
    `${Object.keys(manifest.fileExtensions).length} extensions, ` +
    `${Object.keys(manifest.folderNames).length} folder names`,
);
