// Portão de delegação: audita, no fim do turno, se o agente principal fez
// trabalho de leitura pesado SEM delegar ao subagente explorer (haiku).
// Ver docs/superpowers/specs/2026-07-25-portao-delegacao-design.md

/** Invocar qualquer uma destas conta como delegação de verdade. */
export const DELEGATION_TOOLS = new Set(['Agent', 'Task', 'Skill']);

/** Tools que representam trabalho de pesquisa/edição — o que se quer delegar. */
export const HEAVY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit',
]);

/** Valor de partida herdado do auditor de referência externo. A medir, não presumir. */
export const HEAVY_THRESHOLD = 6;

export interface TurnClassification {
  heavy: number;
  delegated: boolean;
  /** true = trabalho pesado sem delegação; só este caso sobe ao juiz. */
  ambiguous: boolean;
}

export function classifyTurn(tools: string[]): TurnClassification {
  let heavy = 0;
  let delegated = false;
  for (const t of tools) {
    if (DELEGATION_TOOLS.has(t)) delegated = true;
    if (HEAVY_TOOLS.has(t)) heavy++;
  }
  return { heavy, delegated, ambiguous: !delegated && heavy >= HEAVY_THRESHOLD };
}
