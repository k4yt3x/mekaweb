import {
  Activity,
  BookOpen,
  Bot,
  CalendarClock,
  FilePenLine,
  FilePlusCorner,
  FileText,
  FoldVertical,
  FolderSearch,
  Gauge,
  Globe,
  Image,
  ListTodo,
  MessageSquareText,
  NotebookPen,
  Plug,
  SquareTerminal,
  Sparkles,
  TextSearch,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

// meka 0.68.0: src/tools/registry.rs::BUILTIN_TOOL_NAMES. An entry ending in `_` covers every tool
// named with that prefix, and matches the navigation's icon where the two overlap. MCP server tools
// are named `mcp__{server}__{tool}`, so they share a prefix too.
export const toolIcons: Readonly<Record<string, LucideIcon>> = {
  agent_: Bot,
  context_check: Gauge,
  context_compact: FoldVertical,
  context_replace: FoldVertical,
  conversation_: MessageSquareText,
  file_edit: FilePenLine,
  file_find: FolderSearch,
  file_read: FileText,
  file_search: TextSearch,
  file_write: FilePlusCorner,
  image_render: Image,
  mcp_: Plug,
  memory_: BookOpen,
  schedule_: CalendarClock,
  scratchpad_: NotebookPen,
  shell_execute: SquareTerminal,
  skill_: Sparkles,
  task_: Activity,
  todo_: ListTodo,
  tool_: Wrench,
  web_fetch: Globe,
  // The supported 0.59 API uses these older names.
  edit_file: FilePenLine,
  execute_command: SquareTerminal,
  fetch_url: Globe,
  find_files: FolderSearch,
  load_tool: Wrench,
  read_file: FileText,
  render_image: Image,
  search_contents: TextSearch,
  write_file: FilePlusCorner,
};

/** The tool's own entry in `toolIcons`, else its family's, else an empty key with no entry. */
export function toolIconKey(name: string) {
  const prefix = name.slice(0, name.indexOf('_') + 1);
  return [name, prefix].find((key) => Object.hasOwn(toolIcons, key)) ?? '';
}
