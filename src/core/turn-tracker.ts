// Acumula, por sessão, os nomes das tools chamadas no turno corrente.
// Alimentado pelo hook PreToolUse; consumido (e zerado) pelo hook Stop.
//
// Chamadas vindas de DENTRO de um subagente são ignoradas de propósito: se
// contassem, delegar ao explorer — que lê muitos arquivos — faria o próprio
// portão disparar contra a delegação que ele quer incentivar.
import { DELEGATION_TOOLS } from './delegation-gate.ts';

const turns = new Map<string, string[]>();

// Delegação pegajosa: uma Skill invocada no turno N é EXECUTADA no turno N+1.
// Sem isto, o turno de execução parece trabalho pesado sem delegação — falso
// positivo observado no auditor de referência externo em 2026-07-25 (spec §7 item 4).
const stickyNext = new Set<string>();

export interface TurnSnapshot {
  tools: string[];
  /** true = o turno ANTERIOR delegou; conta como delegação neste também. */
  stickyDelegation: boolean;
}

export function recordTool(sessionId: string, toolName: string, isSubagent: boolean): void {
  if (isSubagent) return;
  const list = turns.get(sessionId);
  if (list) list.push(toolName);
  else turns.set(sessionId, [toolName]);
}

/** Devolve o turno e zera o acumulador da sessão. */
export function takeTurn(sessionId: string): TurnSnapshot {
  const tools = turns.get(sessionId) ?? [];
  turns.delete(sessionId);

  const stickyDelegation = stickyNext.has(sessionId);
  stickyNext.delete(sessionId); // vale por UM turno só

  if (tools.some((t) => DELEGATION_TOOLS.has(t))) stickyNext.add(sessionId);

  return { tools, stickyDelegation };
}

/** Só para testes. */
export function resetAll(): void {
  turns.clear();
  stickyNext.clear();
}
