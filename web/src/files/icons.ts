import manifest from './file-icons.json';

/**
 * File and folder icons from Material Icon Theme, as VS Code shows them: by a file's name, then its
 * longest extension, `.test.ts` before `.ts`; by a folder's name, open or closed. Each icon is its
 * own file, fetched the first time it shows.
 */
const urls = new Map(
  Object.entries(
    import.meta.glob<string>('../../node_modules/material-icon-theme/icons/*.svg', {
      query: '?url&no-inline',
      import: 'default',
      eager: true,
    }),
  ).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.svg'.length), url]),
);

/** `grouped`, each icon with its names, as each name with its icon. */
function byName(grouped: Record<string, string[]>) {
  const names = new Map<string, string>();
  for (const [icon, list] of Object.entries(grouped))
    for (const name of list) names.set(name, icon);
  return names;
}

const fileNames = byName(manifest.files);
const extensions = byName(manifest.extensions);
const folderNames = byName(manifest.folders);
const opened = new Map(Object.entries(manifest.opened as Record<string, string>));
const light = new Set(manifest.light);

/** The icon for the file `name`. */
export function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  const named = fileNames.get(lower);
  if (named) return named;
  for (let dot = lower.indexOf('.'); dot >= 0; dot = lower.indexOf('.', dot + 1)) {
    const icon = extensions.get(lower.slice(dot + 1));
    if (icon) return icon;
  }
  return manifest.file;
}

/** The icon for the folder `name`, open or closed; the root shown has its own. */
export function folderIconName(name: string, open: boolean, root = false): string {
  if (root) return open ? `${manifest.root}-open` : manifest.root;
  const lower = name.toLowerCase();
  const icon = folderNames.get(lower);
  if (!icon) return open ? `${manifest.folder}-open` : manifest.folder;
  return open ? (opened.get(lower) ?? `${icon}-open`) : icon;
}

/** Where the icon `icon` is, in its light form on a light page where it has one. */
export function iconUrl(icon: string, dark: boolean): string {
  const shown = !dark && light.has(icon) ? `${icon}_light` : icon;
  return urls.get(shown) ?? urls.get(icon) ?? urls.get(manifest.file) ?? '';
}
