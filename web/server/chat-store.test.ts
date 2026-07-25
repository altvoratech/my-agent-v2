import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => { process.env.CHAT_DB = ':memory:'; });

describe('delegation_audits', () => {
  it('grava e lê de volta uma auditoria', async () => {
    const store = await import('./chat-store.ts');
    store.recordDelegationAudit({
      id: 'a1', chatId: null, createdAt: new Date(0).toISOString(),
      toolCounts: JSON.stringify({ Read: 8 }), heavyCount: 8, delegated: 0,
      layer: 'judge', verdict: 'block', reason: 'delegue ao explorer', judgeCostUsd: 0.0002,
    });
    const rows = store.listDelegationAudits(null);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('block');
    expect(rows[0].heavyCount).toBe(8);
  });
});
