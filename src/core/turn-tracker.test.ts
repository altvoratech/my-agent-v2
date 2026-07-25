// src/core/turn-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { recordTool, takeTurn, resetAll } from './turn-tracker.ts';

describe('turn-tracker', () => {
  beforeEach(() => resetAll());

  it('acumula tools da sessão na ordem', () => {
    recordTool('s1', 'Read', false);
    recordTool('s1', 'Grep', false);
    expect(takeTurn('s1').tools).toEqual(['Read', 'Grep']);
  });

  it('IGNORA chamadas vindas de subagente', () => {
    recordTool('s1', 'Read', true);
    recordTool('s1', 'Read', true);
    recordTool('s1', 'Agent', false);
    expect(takeTurn('s1').tools).toEqual(['Agent']);
  });

  it('isola sessões diferentes', () => {
    recordTool('s1', 'Read', false);
    recordTool('s2', 'Bash', false);
    expect(takeTurn('s1').tools).toEqual(['Read']);
    expect(takeTurn('s2').tools).toEqual(['Bash']);
  });

  it('takeTurn zera o acumulador', () => {
    recordTool('s1', 'Read', false);
    expect(takeTurn('s1').tools).toEqual(['Read']);
    expect(takeTurn('s1').tools).toEqual([]);
  });

  it('delegação é pegajosa por um turno (Skill executa no turno seguinte)', () => {
    recordTool('s1', 'Skill', false);
    expect(takeTurn('s1').stickyDelegation).toBe(false); // o próprio turno já tem a tool
    // turno seguinte: só trabalho pesado, mas a delegação anterior ainda conta
    recordTool('s1', 'Read', false);
    expect(takeTurn('s1').stickyDelegation).toBe(true);
    // e o turno depois desse já não é mais pegajoso
    recordTool('s1', 'Read', false);
    expect(takeTurn('s1').stickyDelegation).toBe(false);
  });
});
