import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, ChatMessage, AgentEvent } from '../types';
import { ANTHROPIC_TOOLS, executeTool } from './tools';

export interface StreamHandlers {
  onDelta: (textDelta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

export interface AnthropicStreamHandlers extends StreamHandlers {
  onAgentEvent?: (ev: AgentEvent) => void;
  projectId?: string;
}

export function makeClient(cfg: AppConfig): Anthropic {
  return new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
  });
}

export async function streamMessage(
  cfg: AppConfig,
  system: string,
  history: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const anthropicHandlers = handlers as AnthropicStreamHandlers;
  if (!cfg.apiKey) {
    handlers.onError(new Error('Missing API key — open Settings and paste one in.'));
    return;
  }

  const client = makeClient(cfg);
  const messages = buildMessages(history);
  let acc = '';

  try {
    await runWithToolLoop(client, cfg, system, messages, signal, handlers, anthropicHandlers, acc);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

async function runWithToolLoop(
  client: Anthropic,
  cfg: AppConfig,
  system: string,
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
  handlers: StreamHandlers,
  anthropicHandlers: AnthropicStreamHandlers,
  acc: string,
): Promise<void> {
  const MAX_TOOL_ROUNDS = 8;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await streamOneTurn(client, cfg, system, messages, signal, handlers);
    acc = result.acc;

    if (result.toolUseBlocks.length === 0) {
      handlers.onDone(acc);
      return;
    }

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of result.toolUseBlocks) {
      anthropicHandlers.onAgentEvent?.({
        kind: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input as Record<string, unknown>,
      });

      const toolResult = await executeTool(
        tu.name,
        JSON.stringify(tu.input),
        anthropicHandlers.projectId,
      );

      anthropicHandlers.onAgentEvent?.({
        kind: 'tool_result',
        toolUseId: tu.id,
        content: toolResult.content,
        isError: toolResult.isError,
      });

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: toolResult.content,
        is_error: toolResult.isError,
      });
    }

    messages.push({
      role: 'assistant',
      content: result.contentBlocks,
    });

    messages.push({
      role: 'user',
      content: toolResultBlocks,
    });

    acc = '';
  }

  handlers.onDone(acc);
}

async function streamOneTurn(
  client: Anthropic,
  cfg: AppConfig,
  system: string,
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<{
  acc: string;
  toolUseBlocks: Anthropic.ToolUseBlock[];
  contentBlocks: Anthropic.ContentBlock[];
}> {
  const stream = client.messages.stream(
    {
      model: cfg.model,
      max_tokens: 8192,
      system,
      messages,
      tools: ANTHROPIC_TOOLS as Anthropic.Tool[],
    },
    { signal },
  );

  stream.on('text', (delta) => {
    handlers.onDelta(delta);
  });

  const finalMessage = await stream.finalMessage();

  let acc = '';
  const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
  const contentBlocks: Anthropic.ContentBlock[] = [];

  for (const block of finalMessage.content) {
    if (block.type === 'text') {
      acc += block.text;
      contentBlocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      toolUseBlocks.push(block);
      contentBlocks.push(block);
    }
  }

  return { acc, toolUseBlocks, contentBlocks };
}

function buildMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const m of history) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
      continue;
    }

    const toolUses = m.events?.filter((e) => e.kind === 'tool_use');
    const toolResults = m.events?.filter((e) => e.kind === 'tool_result');

    if (m.role === 'assistant' && toolUses && toolUses.length > 0) {
      const content: Anthropic.ContentBlock[] = [];
      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }
      for (const tu of toolUses) {
        content.push({
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        });
      }
      messages.push({ role: 'assistant', content });

      if (toolResults && toolResults.length > 0) {
        const resultContent: Anthropic.ToolResultBlockParam[] = toolResults.map((tr) => ({
          type: 'tool_result' as const,
          tool_use_id: tr.toolUseId,
          content: tr.content,
          is_error: tr.isError,
        }));
        messages.push({ role: 'user', content: resultContent });
      }
    } else {
      messages.push({ role: m.role as 'assistant', content: m.content });
    }
  }

  return messages;
}
