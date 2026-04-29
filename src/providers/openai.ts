import type { AppConfig, ChatMessage, AgentEvent } from '../types';
import type { StreamHandlers } from './anthropic';
import { OPENAI_TOOLS, executeTool } from './tools';

export interface OpenAIStreamHandlers extends StreamHandlers {
  onAgentEvent?: (ev: AgentEvent) => void;
  projectId?: string;
}

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null }
  | { role: 'assistant'; content: string | null; tool_calls: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export async function streamMessage(
  cfg: AppConfig,
  system: string,
  history: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const openaiHandlers = handlers as OpenAIStreamHandlers;
  if (!cfg.apiKey) {
    handlers.onError(new Error('Missing API key — open Settings and paste one in.'));
    return;
  }

  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const messages = buildMessages(system, history);
  let acc = '';

  try {
    await runWithToolLoop(url, cfg, messages, signal, handlers, openaiHandlers, acc);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

async function runWithToolLoop(
  url: string,
  cfg: AppConfig,
  messages: OpenAIMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
  openaiHandlers: OpenAIStreamHandlers,
  acc: string,
): Promise<void> {
  const MAX_TOOL_ROUNDS = 8;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await streamOneTurn(url, cfg, messages, signal, handlers);
    acc = result.acc;

    if (result.toolCalls.length === 0) {
      handlers.onDone(acc);
      return;
    }

    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      content: acc || null,
      tool_calls: result.toolCalls,
    };
    messages.push(assistantMsg);

    for (const tc of result.toolCalls) {
      openaiHandlers.onAgentEvent?.({
        kind: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });

      const toolResult = await executeTool(
        tc.function.name,
        tc.function.arguments,
        openaiHandlers.projectId,
      );

      openaiHandlers.onAgentEvent?.({
        kind: 'tool_result',
        toolUseId: tc.id,
        content: toolResult.content,
        isError: toolResult.isError,
      });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolResult.content,
      });
    }

    acc = '';
  }

  handlers.onDone(acc);
}

async function streamOneTurn(
  url: string,
  cfg: AppConfig,
  messages: OpenAIMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<{ acc: string; toolCalls: OpenAIToolCall[] }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      tools: OPENAI_TOOLS,
    }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text || 'no body'}`);
  }

  if (!resp.body) {
    throw new Error('Response body is empty');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  const toolCallAccumulators = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);

      if (!line || !line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;

      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
        };

        const choice = parsed.choices?.[0];
        if (!choice?.delta) continue;

        if (choice.delta.content) {
          acc += choice.delta.content;
          handlers.onDelta(choice.delta.content);
        }

        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            let entry = toolCallAccumulators.get(tc.index);
            if (!entry) {
              entry = { id: '', name: '', arguments: '' };
              toolCallAccumulators.set(tc.index, entry);
            }
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }
      } catch {
        // skip malformed JSON lines
      }
    }
  }

  const toolCalls: OpenAIToolCall[] = [];
  const sorted = [...toolCallAccumulators.entries()].sort(([a], [b]) => a - b);
  for (const [, entry] of sorted) {
    if (entry.id && entry.name) {
      toolCalls.push({
        id: entry.id,
        type: 'function',
        function: { name: entry.name, arguments: entry.arguments },
      });
    }
  }

  return { acc, toolCalls };
}

function buildMessages(system: string, history: ChatMessage[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  for (const m of history) {
    const toolUses = m.events?.filter((e) => e.kind === 'tool_use');
    const toolResults = m.events?.filter((e) => e.kind === 'tool_result');

    if (m.role === 'assistant' && toolUses && toolUses.length > 0) {
      const toolCalls: OpenAIToolCall[] = toolUses.map((e) => ({
        id: e.id,
        type: 'function' as const,
        function: {
          name: e.name,
          arguments: JSON.stringify(e.input ?? {}),
        },
      }));
      messages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: toolCalls,
      });
      if (toolResults) {
        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolUseId,
            content: tr.content,
          });
        }
      }
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}
