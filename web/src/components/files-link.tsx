import { FolderOpen } from 'lucide-react';
import { basename, parent } from '../files/paths';
import { useWorkspace } from './workspace';

/** Opens the file `path` in the session's Files, beside the conversation. */
export function FilesLink({ path }: { path: string }) {
  const workspace = useWorkspace();
  if (!workspace) return null;
  return (
    <button
      type="button"
      className="button button-ghost button-small files-link"
      onClick={() => workspace.openFiles(parent(path), basename(path))}
    >
      <FolderOpen size={14} aria-hidden="true" />
      Open in Files
    </button>
  );
}
