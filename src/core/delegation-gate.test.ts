import { describe, it, expect } from 'vitest';
import { classifyTurn, HEAVY_THRESHOLD } from './delegation-gate.ts';

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
