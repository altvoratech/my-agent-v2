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

  it('I1: cap por sessão — guarda só as últimas 200 tools', () => {
    for (let i = 0; i < 205; i++) recordTool('s1', `Tool${i}`, false);
    const { tools } = takeTurn('s1');
    expect(tools.length).toBe(200);
    expect(tools[0]).toBe('Tool5'); // as 5 mais antigas caíram fora
    expect(tools[tools.length - 1]).toBe('Tool204');
  });

  it('I1: cap de sessões rastreadas — evict da mais antiga acima de 50', () => {
    for (let i = 0; i < 55; i++) recordTool(`sess-${i}`, 'Read', false);
    // as 5 primeiras (sess-0..sess-4) devem ter sido evictadas
    expect(takeTurn('sess-0').tools).toEqual([]);
    expect(takeTurn('sess-4').tools).toEqual([]);
    // a mais recente sobrevive
    expect(takeTurn('sess-54').tools).toEqual(['Read']);
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
