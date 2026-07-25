import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.ts', () => ({
  log: { info: vi.fn().mockResolvedValue(undefined), warn: vi.fn(), error: vi.fn() },
  logEvents: { emit: vi.fn() },
  LOG_FILE: 'logs/app.jsonl', LOG_FILE_TXT: 'logs/app.log', LOG_DIR: 'logs',
}));

import { onPreToolUse } from './hooks.ts';
import { takeTurn, resetAll } from './turn-tracker.ts';

function preInput(tool: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: {},
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    ...extra,
  } as never;
}

describe('onPreToolUse alimenta o turn-tracker', () => {
  beforeEach(() => resetAll());

  it('registra tool do agente principal', async () => {
    await onPreToolUse(preInput('Read'), 'id-1', {} as never);
    expect(takeTurn('sess-1').tools).toEqual(['Read']);
  });

  it('ignora tool disparada de dentro de subagente', async () => {
    await onPreToolUse(preInput('Read', { agent_id: 'sub-9' }), 'id-2', {} as never);
    expect(takeTurn('sess-1').tools).toEqual([]);
  });
});
