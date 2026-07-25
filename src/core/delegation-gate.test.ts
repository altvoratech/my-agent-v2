import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyTurn, HEAVY_THRESHOLD, parseVerdict, createDelegationGate, JUDGE_TIMEOUT_MS, countOf } from './delegation-gate.ts';
import { recordTool, resetAll } from './turn-tracker.ts';

function stopInput(sessionId = 'sess-1', active = false) {
  return {
    hook_event_name: 'Stop',
    stop_hook_active: active,
    session_id: sessionId,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
  } as never;
}

describe('classifyTurn', () => {
  it('turno leve não é ambíguo', () => {
    expect(classifyTurn(['Read', 'Read'])).toEqual({ heavy: 2, delegated: false, ambiguous: false });
  });

  it('turno que delegou não é ambíguo, mesmo pesado', () => {
    const tools = [...Array(10).fill('Read'), 'Agent'];
    expect(classifyTurn(tools)).toEqual({ heavy: 10, delegated: true, ambiguous: false });
  });

  it('Skill conta como delegação', () => {
    const tools = [...Array(8).fill('Grep'), 'Skill'];
    expect(classifyTurn(tools).delegated).toBe(true);
  });

  it('trabalho pesado sem delegação é ambíguo', () => {
    const tools = Array(HEAVY_THRESHOLD).fill('Read');
    expect(classifyTurn(tools)).toEqual({ heavy: HEAVY_THRESHOLD, delegated: false, ambiguous: true });
  });

  it('tools não-pesadas não contam para o limiar', () => {
    const tools = Array(20).fill('TodoWrite');
    expect(classifyTurn(tools).ambiguous).toBe(false);
  });
});

describe('countOf', () => {
  it('mesma carga em ordens diferentes gera a MESMA string (canônico)', () => {
    expect(countOf(['Read', 'Grep'])).toBe(countOf(['Grep', 'Read']));
    expect(countOf(['Read', 'Bash', 'Read', 'Glob'])).toBe(countOf(['Glob', 'Read', 'Bash', 'Read']));
  });

  it('serializa as chaves em ordem alfabética', () => {
    expect(countOf(['Read', 'Bash', 'Glob'])).toBe('{"Bash":1,"Glob":1,"Read":1}');
  });

  it('conta as repetições', () => {
    expect(countOf(['Read', 'Read', 'Read', 'Grep'])).toBe('{"Grep":1,"Read":3}');
  });

  it('turno vazio vira objeto vazio', () => {
    expect(countOf([])).toBe('{}');
  });
});

describe('parseVerdict', () => {
  it('extrai JSON mesmo com texto em volta', () => {
    expect(parseVerdict('Claro!\n{"ok": false, "reason": "delegue"}\n')).toEqual({ ok: false, reason: 'delegue' });
  });

  it('devolve null para resposta sem JSON', () => {
    expect(parseVerdict('não sei')).toBeNull();
  });

  it('devolve null para JSON malformado', () => {
    expect(parseVerdict('{"ok": tru')).toBeNull();
  });

  it('devolve null quando ok não é booleano', () => {
    expect(parseVerdict('{"ok": "sim"}')).toBeNull();
  });
});

describe('createDelegationGate', () => {
  beforeEach(() => resetAll());

  it('turno leve libera sem chamar o juiz', async () => {
    const judgeFn = vi.fn();
    const gate = createDelegationGate({ judgeFn });
    recordTool('sess-1', 'Read', false);
    expect(await gate(stopInput(), '', {} as never)).toEqual({});
    expect(judgeFn).not.toHaveBeenCalled();
  });

  it('turno pesado que delegou libera sem chamar o juiz', async () => {
    const judgeFn = vi.fn();
    const gate = createDelegationGate({ judgeFn });
    for (let i = 0; i < 10; i++) recordTool('sess-1', 'Read', false);
    recordTool('sess-1', 'Agent', false);
    expect(await gate(stopInput(), '', {} as never)).toEqual({});
    expect(judgeFn).not.toHaveBeenCalled();
  });

  it('turno ambíguo com veredito ok:false bloqueia com a lacuna', async () => {
    const judgeFn = vi.fn().mockResolvedValue({ ok: false, reason: 'delegue ao explorer' });
    const gate = createDelegationGate({ judgeFn });
    for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
    const out = await gate(stopInput(), '', {} as never);
    expect(out).toEqual({ decision: 'block', reason: 'delegue ao explorer' });
  });

  it('juiz que lança libera (fail-open)', async () => {
    const judgeFn = vi.fn().mockRejectedValue(new Error('boom'));
    const gate = createDelegationGate({ judgeFn });
    for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
    expect(await gate(stopInput(), '', {} as never)).toEqual({});
  });

  it('juiz que devolve null libera (fail-open)', async () => {
    const judgeFn = vi.fn().mockResolvedValue(null);
    const gate = createDelegationGate({ judgeFn });
    for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
    expect(await gate(stopInput(), '', {} as never)).toEqual({});
  });

  it('stop_hook_active libera sem auditar (anti-loop)', async () => {
    const judgeFn = vi.fn();
    const onAudit = vi.fn();
    const gate = createDelegationGate({ judgeFn, onAudit });
    for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
    expect(await gate(stopInput('sess-1', true), '', {} as never)).toEqual({});
    expect(judgeFn).not.toHaveBeenCalled();
    expect(onAudit).not.toHaveBeenCalled();
  });

  it('modo observação grava mas não bloqueia', async () => {
    const judgeFn = vi.fn().mockResolvedValue({ ok: false, reason: 'delegue' });
    const onAudit = vi.fn();
    const gate = createDelegationGate({ judgeFn, onAudit, enabled: false });
    for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
    expect(await gate(stopInput(), '', {} as never)).toEqual({});
    expect(onAudit).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'block' }));
  });

  it('grava também os turnos liberados pela camada determinística', async () => {
    const onAudit = vi.fn();
    const gate = createDelegationGate({ judgeFn: vi.fn(), onAudit });
    recordTool('sess-1', 'Read', false);
    await gate(stopInput(), '', {} as never);
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 'deterministic', verdict: 'allow', heavyCount: 1 }),
    );
  });

  it('anti-loop drena o acumulador (tools não vazam para o turno seguinte)', async () => {
    const judgeFn = vi.fn();
    const gate = createDelegationGate({ judgeFn });
    for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
    await gate(stopInput('sess-1', true), '', {} as never);   // anti-loop
    expect(await gate(stopInput('sess-1'), '', {} as never)).toEqual({}); // turno seguinte vazio
    expect(judgeFn).not.toHaveBeenCalled();                    // falharia se as tools tivessem vazado
  });

  it('juiz que nunca resolve libera dentro do prazo (C1: fail-open no timeout)', async () => {
    vi.useFakeTimers();
    try {
      const judgeFn = vi.fn(() => new Promise<never>(() => {})); // pendura pra sempre
      const gate = createDelegationGate({ judgeFn });
      for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
      const out = gate(stopInput(), '', {} as never);
      await vi.advanceTimersByTimeAsync(JUDGE_TIMEOUT_MS);
      expect(await out).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('turno pegajoso não sobe ao juiz', async () => {
    const judgeFn = vi.fn();
    const gate = createDelegationGate({ judgeFn });
    recordTool('sess-1', 'Skill', false);
    await gate(stopInput(), '', {} as never);                  // drena e arma o sticky
    for (let i = 0; i < 8; i++) recordTool('sess-1', 'Read', false);
    expect(await gate(stopInput(), '', {} as never)).toEqual({});
    expect(judgeFn).not.toHaveBeenCalled();
  });
});
