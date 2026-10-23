/**
 * Paths as the server writes them: on Unix from `/`, on Windows from a drive, `C:\`, or a share,
 * `\\server\share\`, with `\` between names, though `/` is taken too.
 */
function isWindows(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

/** Whether `path` is absolute. */
export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || isWindows(path);
}

/** The separator `path` is written with. */
export function separator(path: string): string {
  return isWindows(path) ? '\\' : '/';
}

/** Whether `char` separates names in `path`. */
function separates(path: string, char: string | undefined): boolean {
  return char === '/' || (char === '\\' && isWindows(path));
}

/** The folder the absolute `path` starts from: `/`, `C:\` or `\\server\share\`. */
function root(path: string): string {
  const drive = /^[A-Za-z]:[\\/]/.exec(path);
  if (drive) return drive[0];
  const share = /^\\\\[^\\/]+[\\/][^\\/]+/.exec(path);
  if (share) return `${share[0]}\\`;
  return path.startsWith('/') ? '/' : '';
}

/** `path`, whose root is `top`, without separators at its end, short of its root. */
function trimmed(path: string, top: string): string {
  let end = path.length;
  while (end > top.length && separates(path, path[end - 1])) end--;
  return path.slice(0, end);
}

/** Where the last separator in `path`, whose root is `top`, is past its root; -1 if none is. */
function lastSeparator(path: string, top: string): number {
  for (let index = path.length - 1; index >= top.length; index--)
    if (separates(path, path[index])) return index;
  return -1;
}

/** `name` within the folder `path`, both absolute; a name may hold `/` between its parts. */
export function join(path: string, name: string): string {
  const between = separator(path);
  const parts = between === '/' ? name : name.replaceAll('/', between);
  return separates(path, path.at(-1)) ? `${path}${parts}` : `${path}${between}${parts}`;
}

/** The folder the absolute `path` is in; a root folder is its own. */
export function parent(path: string): string {
  const top = root(path);
  const rest = trimmed(path, top);
  if (rest.length <= top.length) return top || path;
  const index = lastSeparator(rest, top);
  return index < 0 ? top : rest.slice(0, index);
}

/** Whether `path` is a root folder, with no folder above it. */
export function isRoot(path: string): boolean {
  return parent(path) === path;
}

/** The last name of `path`. */
export function basename(path: string): string {
  const top = root(path);
  const rest = trimmed(path, top);
  return rest.slice(Math.max(lastSeparator(rest, top), top.length - 1) + 1);
}

/** The folders of the absolute `path`, from its root down, each with the path to it. */
export function crumbs(path: string): { name: string; path: string }[] {
  const top = root(path);
  const between = separator(path);
  const names = path
    .slice(top.length)
    .split(between === '/' ? '/' : /[\\/]/)
    .filter(Boolean);
  return [
    { name: top, path: top },
    ...names.map((name, index) => ({
      name,
      path: top + names.slice(0, index + 1).join(between),
    })),
  ];
}

/** A byte count as people read it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const languages: Record<string, string> = {
  rs: 'rust',
  py: 'python',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  yml: 'yaml',
  sh: 'bash',
  zsh: 'bash',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  kt: 'kotlin',
  rb: 'ruby',
  conf: 'ini',
};

/** The highlighting language for a file name, if it names one. */
export function language(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'make';
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (!extension) return undefined;
  return languages[extension] ?? extension;
}

/** How a file previews, by its name. */
export function previewKind(name: string): 'image' | 'video' | 'audio' | 'pdf' | 'text' {
  const extension = name.toLowerCase().slice(name.lastIndexOf('.') + 1);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'].includes(extension))
    return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus'].includes(extension))
    return 'audio';
  if (extension === 'pdf') return 'pdf';
  return 'text';
}

/** The address of a file's contents, shown in place or downloaded. */
export function rawUrl(path: string, download = false): string {
  const url = new URL('/api/files/raw', location.origin);
  url.searchParams.set('path', path);
  if (download) url.searchParams.set('download', 'true');
  return url.pathname + url.search;
}

/** The address of a folder as a zip. */
export function zipUrl(path: string): string {
  const url = new URL('/api/files/zip', location.origin);
  url.searchParams.set('path', path);
  return url.pathname + url.search;
}

/** The address of a zip of entries chosen, by the id mekaweb keeps them under. */
export function selectionZipUrl(id: string): string {
  const url = new URL('/api/files/zip', location.origin);
  url.searchParams.set('selection', id);
  return url.pathname + url.search;
}

/** The tools whose `path` names a file the agent read or changed. */
const FILE_TOOLS = new Set(['file_read', 'file_write', 'file_edit']);

/** The absolute file path a tool call names, if it is a file tool's. */
export function toolPath(name: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(name) || !input || typeof input !== 'object') return undefined;
  const path = (input as Record<string, unknown>).path;
  return typeof path === 'string' && isAbsolute(path) ? path : undefined;
}
