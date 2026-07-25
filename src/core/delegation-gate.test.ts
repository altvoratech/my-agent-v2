import { describe, it, expect } from 'vitest';
import { classifyTurn, HEAVY_THRESHOLD, parseVerdict } from './delegation-gate.ts';

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
