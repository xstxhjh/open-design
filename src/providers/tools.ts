import type { AgentEvent } from '../types';

export interface ToolStreamHandlers {
  onDelta: (textDelta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
  onAgentEvent?: (ev: AgentEvent) => void;
  projectId?: string;
}

export const TOOL_DEFINITIONS = {
  read: {
    name: 'Read',
    description: 'Read the contents of a file at the given path. Returns the file content as a string.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to read, relative to the project root.',
        },
      },
      required: ['file_path'],
    },
  },
  write: {
    name: 'Write',
    description: 'Write content to a file at the given path. Creates the file if it does not exist, overwrites if it does.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to write, relative to the project root.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  edit: {
    name: 'Edit',
    description: 'Edit a file by replacing a specific string with a new string. The old_string must match exactly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to edit, relative to the project root.',
        },
        old_string: {
          type: 'string',
          description: 'The exact string to find and replace.',
        },
        new_string: {
          type: 'string',
          description: 'The string to replace old_string with.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  listFiles: {
    name: 'ListFiles',
    description: 'List all files in the project directory.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
};

export const ANTHROPIC_TOOLS = [
  TOOL_DEFINITIONS.read,
  TOOL_DEFINITIONS.write,
  TOOL_DEFINITIONS.edit,
  TOOL_DEFINITIONS.listFiles,
];

export const OPENAI_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: TOOL_DEFINITIONS.read.name,
      description: TOOL_DEFINITIONS.read.description,
      parameters: TOOL_DEFINITIONS.read.input_schema,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: TOOL_DEFINITIONS.write.name,
      description: TOOL_DEFINITIONS.write.description,
      parameters: TOOL_DEFINITIONS.write.input_schema,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: TOOL_DEFINITIONS.edit.name,
      description: TOOL_DEFINITIONS.edit.description,
      parameters: TOOL_DEFINITIONS.edit.input_schema,
    },
  },
  {
    type: 'function' as const,
    function: {
      name: TOOL_DEFINITIONS.listFiles.name,
      description: TOOL_DEFINITIONS.listFiles.description,
      parameters: TOOL_DEFINITIONS.listFiles.input_schema,
    },
  },
];

export async function executeTool(
  name: string,
  argumentsJson: string,
  projectId?: string,
): Promise<{ content: string; isError: boolean }> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson || '{}');
  } catch {
    return { content: `Error: invalid JSON arguments for ${name}`, isError: true };
  }

  if (!projectId) {
    return {
      content: `Error: no project context available for tool execution. Switch to daemon mode or open a project.`,
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'Read': {
        const filePath = String(args.file_path ?? '');
        const resp = await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(filePath)}`);
        if (!resp.ok) {
          return { content: `Error: file not found: ${filePath}`, isError: true };
        }
        const content = await resp.text();
        return { content, isError: false };
      }

      case 'Write': {
        const filePath = String(args.file_path ?? '');
        const content = String(args.content ?? '');
        const resp = await fetch(`/api/projects/${projectId}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: filePath, content }),
        });
        if (!resp.ok) {
          const err = await resp.text().catch(() => 'unknown error');
          return { content: `Error writing file: ${err}`, isError: true };
        }
        return { content: `Successfully wrote ${filePath}`, isError: false };
      }

      case 'Edit': {
        const filePath = String(args.file_path ?? '');
        const oldString = String(args.old_string ?? '');
        const newString = String(args.new_string ?? '');

        const readResp = await fetch(`/api/projects/${projectId}/files/${encodeURIComponent(filePath)}`);
        if (!readResp.ok) {
          return { content: `Error: file not found: ${filePath}`, isError: true };
        }
        let fileContent = await readResp.text();

        if (!fileContent.includes(oldString)) {
          return {
            content: `Error: old_string not found in ${filePath}. The exact text must match.`,
            isError: true,
          };
        }

        fileContent = fileContent.replace(oldString, newString);

        const writeResp = await fetch(`/api/projects/${projectId}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: filePath, content: fileContent }),
        });
        if (!writeResp.ok) {
          const err = await writeResp.text().catch(() => 'unknown error');
          return { content: `Error writing file: ${err}`, isError: true };
        }
        return { content: `Successfully edited ${filePath}`, isError: false };
      }

      case 'ListFiles': {
        const resp = await fetch(`/api/projects/${projectId}/files`);
        if (!resp.ok) {
          return { content: 'Error: could not list files', isError: true };
        }
        const data = (await resp.json()) as { files: Array<{ name: string; kind: string; size: number }> };
        const listing = data.files
          .map((f) => `${f.name} (${f.kind}, ${f.size} bytes)`)
          .join('\n');
        return { content: listing || 'No files in project.', isError: false };
      }

      default:
        return { content: `Error: unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      content: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
