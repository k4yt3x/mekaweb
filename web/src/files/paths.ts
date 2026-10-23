/** `name` within the folder `path`, both absolute. */
export function join(path: string, name: string): string {
  return path.endsWith('/') ? `${path}${name}` : `${path}/${name}`;
}

/** The folder the absolute `path` is in; the root folder is its own. */
export function parent(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

/** The last name of `path`. */
export function basename(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** The folders of the absolute `path`, from the root down, each with the path to it. */
export function crumbs(path: string): { name: string; path: string }[] {
  const names = path.split('/').filter(Boolean);
  return [
    { name: '/', path: '/' },
    ...names.map((name, index) => ({ name, path: '/' + names.slice(0, index + 1).join('/') })),
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

/** The address of a folder as a zip; with `only`, of just those names in it. */
export function zipUrl(path: string, only?: readonly string[]): string {
  const url = new URL('/api/files/zip', location.origin);
  url.searchParams.set('path', path);
  // No name holds a `/`.
  if (only) url.searchParams.set('only', only.join('/'));
  return url.pathname + url.search;
}

/** The tools whose `path` names a file the agent read or changed. */
const FILE_TOOLS = new Set(['file_read', 'file_write', 'file_edit']);

/** The absolute file path a tool call names, if it is a file tool's. */
export function toolPath(name: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(name) || !input || typeof input !== 'object') return undefined;
  const path = (input as Record<string, unknown>).path;
  return typeof path === 'string' && path.startsWith('/') ? path : undefined;
}
