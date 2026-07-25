// Teste de integração ponta a ponta do portão de delegação: onPreToolUse REAL
// alimentando o turn-tracker REAL, o gate REAL classificando e decidindo, e
// recordDelegationAudit REAL escrevendo no SQLite — lido de volta via
// listDelegationAudits. O único dublê é o judgeFn (não queremos chamada de
// modelo aqui; isso fica no script e2e opt-in scripts/e2e-portao.ts).
//
// Fica em web/server porque cruza src/core (o gate) com web/server (o store) —
// a restrição "src/core não importa de web/" vale para código de produção, não
// para teste.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/core/logger.ts', () => ({
  log: { info: vi.fn().mockResolvedValue(undefined), warn: vi.fn().mockResolvedValue(undefined), error: vi.fn() },
  logEvents: { emit: vi.fn() },
  LOG_FILE: 'logs/app.jsonl', LOG_FILE_TXT: 'logs/app.log', LOG_DIR: 'logs',
}));

import type { DelegationAuditInput } from '../../src/core/delegation-gate.ts';

let onPreToolUse: typeof import('../../src/core/hooks.ts')['onPreToolUse'];
let resetAll: typeof import('../../src/core/turn-tracker.ts')['resetAll'];
let createDelegationGate: typeof import('../../src/core/delegation-gate.ts')['createDelegationGate'];
let recordDelegationAudit: typeof import('./chat-store.ts')['recordDelegationAudit'];
let listDelegationAudits: typeof import('./chat-store.ts')['listDelegationAudits'];
let chatStore: typeof import('./chat-store.ts')['chatStore'];

// delegation_audits.chatId tem FK para chats(id) (ON DELETE CASCADE) — precisa
// apontar para um chat real que exista no banco, senão o insert falha com
// "FOREIGN KEY constraint failed" (recordDelegationAudit lança, o gate captura
// no seu try/catch fail-open e a auditoria nunca chega ao banco).
// Cada teste cria seu PRÓPRIO chat (e usa CHAT_ID = esse id) para isolar suas
// leituras via listDelegationAudits — o banco em memória é compartilhado por
// todo o arquivo, então auditorias de outros testes ficariam misturadas se
// todos usassem o mesmo chatId.
let CHAT_ID: string;

beforeAll(async () => {
  process.env.CHAT_DB = ':memory:';
  // hooks/turn-tracker/delegation-gate não abrem banco nenhum, mas importamos
  // tudo depois de fixar CHAT_DB por consistência com o padrão do repo.
  ({ onPreToolUse } = await import('../../src/core/hooks.ts'));
  ({ resetAll } = await import('../../src/core/turn-tracker.ts'));
  ({ createDelegationGate } = await import('../../src/core/delegation-gate.ts'));
  ({ recordDelegationAudit, listDelegationAudits, chatStore } = await import('./chat-store.ts'));
});

beforeEach(() => {
  resetAll();
  CHAT_ID = chatStore.createChat('portão de delegação - teste de integração').id;
});

function preInput(tool: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: {},
    tool_use_id: `tu-${Math.random()}`,
    session_id: sessionId,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    ...extra,
  } as never;
}

function stopInput(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'Stop',
    stop_hook_active: false,
    session_id: sessionId,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    ...extra,
  } as never;
}

// Grava no store real, com o mesmo mapeamento que web/server/ai-client.ts faz
// em produção (id/chatId/createdAt adicionados na borda, fora do gate).
function makeOnAudit(chatId: string | null) {
  return (row: DelegationAuditInput) => {
    recordDelegationAudit({
      id: `audit-${Math.random()}`,
      chatId,
      createdAt: new Date().toISOString(),
      ...row,
    });
  };
}

async function runTurn(sessionId: string, tools: Array<{ name: string; agentId?: string }>) {
  for (const t of tools) {
    await onPreToolUse(preInput(t.name, sessionId, t.agentId ? { agent_id: t.agentId } : {}), 'id', {} as never);
  }
}

describe('portão de delegação — integração ponta a ponta (SQLite real)', () => {
  it('1. turno leve grava layer=deterministic, verdict=allow, heavyCount correto; juiz nunca chamado', async () => {
    const sessionId = 'sess-leve';
    const judgeFn = vi.fn();
    const gate = createDelegationGate({ onAudit: makeOnAudit(CHAT_ID), judgeFn, enabled: true });

    await runTurn(sessionId, [{ name: 'Read' }, { name: 'Read' }]);
    const result = await gate(stopInput(sessionId), 'id', {} as never);

    expect(result).toEqual({});
    expect(judgeFn).not.toHaveBeenCalled();

    const rows = listDelegationAudits(CHAT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe('deterministic');
    expect(rows[0].verdict).toBe('allow');
    expect(rows[0].heavyCount).toBe(2);
    expect(rows[0].chatId).toBe(CHAT_ID);
  });

  it('2. turno pesado sem delegação, juiz ok:false, modo bloqueio -> verdict=block gravado e gate devolve {decision:"block"}', async () => {
    const sessionId = 'sess-pesado-bloqueio';
    const judgeFn = vi.fn().mockResolvedValue({ ok: false, reason: 'delegue ao explorer' });
    const gate = createDelegationGate({ onAudit: makeOnAudit(CHAT_ID), judgeFn, enabled: true });

    await runTurn(sessionId, Array.from({ length: 6 }, () => ({ name: 'Read' })));
    const result = await gate(stopInput(sessionId), 'id', {} as never);

    expect(judgeFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ decision: 'block', reason: 'delegue ao explorer' });

    const rows = listDelegationAudits(CHAT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe('judge');
    expect(rows[0].verdict).toBe('block');
    expect(rows[0].reason).toBe('delegue ao explorer');
  });

  it('3. modo observação (enabled:false): grava verdict=block MAS o gate devolve {}', async () => {
    const sessionId = 'sess-pesado-observacao';
    const judgeFn = vi.fn().mockResolvedValue({ ok: false, reason: 'delegue ao explorer' });
    const gate = createDelegationGate({ onAudit: makeOnAudit(CHAT_ID), judgeFn, enabled: false });

    await runTurn(sessionId, Array.from({ length: 6 }, () => ({ name: 'Read' })));
    const result = await gate(stopInput(sessionId), 'id', {} as never);

    // o coração do modo observação: audita mas nunca interfere no turno real.
    expect(result).toEqual({});

    const rows = listDelegationAudits(CHAT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('block');
    expect(rows[0].layer).toBe('judge');
  });

  it('4. chamadas de subagente não contam: 10 Reads de subagente + 1 Agent do principal fica leve, não sobe ao juiz', async () => {
    const sessionId = 'sess-subagente';
    const judgeFn = vi.fn();
    const gate = createDelegationGate({ onAudit: makeOnAudit(CHAT_ID), judgeFn, enabled: true });

    await runTurn(sessionId, [
      ...Array.from({ length: 10 }, () => ({ name: 'Read', agentId: 'sub-1' })),
      { name: 'Agent' },
    ]);
    const result = await gate(stopInput(sessionId), 'id', {} as never);

    expect(result).toEqual({});
    expect(judgeFn).not.toHaveBeenCalled();

    const rows = listDelegationAudits(CHAT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].layer).toBe('deterministic');
    expect(rows[0].verdict).toBe('allow');
    // as 10 tools de subagente NÃO contam para heavyCount, nem Agent (não é heavy)
    expect(rows[0].heavyCount).toBe(0);
    expect(rows[0].delegated).toBe(1);
  });

  it('5. pegajosidade ponta a ponta: turno com Skill, depois turno com 8 Reads -> não sobe ao juiz', async () => {
    const sessionId = 'sess-pegajoso';
    const judgeFn = vi.fn();
    const gate = createDelegationGate({ onAudit: makeOnAudit(CHAT_ID), judgeFn, enabled: true });

    // turno 1: delega via Skill
    await runTurn(sessionId, [{ name: 'Skill' }]);
    const result1 = await gate(stopInput(sessionId), 'id', {} as never);
    expect(result1).toEqual({});

    // turno 2: execução da delegação — 8 Reads, sem chamar Agent/Task/Skill de novo
    await runTurn(sessionId, Array.from({ length: 8 }, () => ({ name: 'Read' })));
    const result2 = await gate(stopInput(sessionId), 'id', {} as never);

    expect(result2).toEqual({});
    expect(judgeFn).not.toHaveBeenCalled();

    const rows = listDelegationAudits(CHAT_ID);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.verdict === 'allow')).toBe(true);
    expect(rows[1].heavyCount).toBe(8);
    expect(rows[1].delegated).toBe(1); // pegajosidade contou o turno 2 como delegado
  });

  it('6. toolCounts gravado é JSON parseável e bate com o que foi chamado; chatId gravado é o passado', async () => {
    const sessionId = 'sess-toolcounts';
    const judgeFn = vi.fn();
    const distinctChatId = chatStore.createChat('chat distinto p/ teste 6').id;
    const gate = createDelegationGate({ onAudit: makeOnAudit(distinctChatId), judgeFn, enabled: true });

    await runTurn(sessionId, [{ name: 'Read' }, { name: 'Read' }, { name: 'Grep' }]);
    await gate(stopInput(sessionId), 'id', {} as never);

    const rows = listDelegationAudits(distinctChatId);
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].toolCounts);
    expect(parsed).toEqual({ Read: 2, Grep: 1 });
    expect(rows[0].chatId).toBe(distinctChatId);
  });
});
