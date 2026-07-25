// Acumula, por sessão, os nomes das tools chamadas no turno corrente.
// Alimentado pelo hook PreToolUse; consumido (e zerado) pelo hook Stop.
//
// Chamadas vindas de DENTRO de um subagente são ignoradas de propósito: se
// contassem, delegar ao explorer — que lê muitos arquivos — faria o próprio
// portão disparar contra a delegação que ele quer incentivar.
import { DELEGATION_TOOLS } from './delegation-gate.ts';

// I1 da revisão final: turns/stickyNext cresciam sem limite (processo web é
// de vida longa; o tester alimenta o tracker mas não tem hook Stop que drene).
// Sem TTL/timer de propósito — só caps, verificados a cada escrita.
//
// N=200 tools por sessão: o limiar de ambiguidade é HEAVY_THRESHOLD=6, então
// nada se perde na decisão — guardamos só as últimas N.
const MAX_TOOLS_PER_SESSION = 200;
// Sessões rastreadas ao mesmo tempo: acima disso, evict a mais antiga (LRU
// por ordem de inserção/atualização do Map).
const MAX_TRACKED_SESSIONS = 50;

const turns = new Map<string, string[]>();

// Delegação pegajosa: uma Skill invocada no turno N é EXECUTADA no turno N+1.
// Sem isto, o turno de execução parece trabalho pesado sem delegação — falso
// positivo observado no auditor de referência externo em 2026-07-25.
const stickyNext = new Set<string>();

// Evict a entrada mais antiga (primeira inserida) quando o cap é excedido.
// Funciona tanto para Map (turns) quanto Set (stickyNext) — ambos preservam
// ordem de inserção e expõem keys()/delete() com a mesma assinatura.
function evictOldestIfOverCap(
  store: { size: number; keys(): IterableIterator<string>; delete(key: string): boolean },
  cap: number,
): void {
  while (store.size > cap) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

export interface TurnSnapshot {
  tools: string[];
  /** true = o turno ANTERIOR delegou; conta como delegação neste também. */
  stickyDelegation: boolean;
}

export function recordTool(sessionId: string, toolName: string, isSubagent: boolean): void {
  if (isSubagent) return;
  const list = turns.get(sessionId);
  if (list) {
    list.push(toolName);
    if (list.length > MAX_TOOLS_PER_SESSION) list.splice(0, list.length - MAX_TOOLS_PER_SESSION);
    // toca a entrada: reinsere pra ela virar a "mais recente" na ordem do Map
    turns.delete(sessionId);
    turns.set(sessionId, list);
  } else {
    turns.set(sessionId, [toolName]);
    evictOldestIfOverCap(turns, MAX_TRACKED_SESSIONS);
  }
}

/** Devolve o turno e zera o acumulador da sessão. */
export function takeTurn(sessionId: string): TurnSnapshot {
  const tools = turns.get(sessionId) ?? [];
  turns.delete(sessionId);

  const stickyDelegation = stickyNext.has(sessionId);
  stickyNext.delete(sessionId); // vale por UM turno só

  if (tools.some((t) => DELEGATION_TOOLS.has(t))) {
    stickyNext.add(sessionId);
    evictOldestIfOverCap(stickyNext, MAX_TRACKED_SESSIONS);
  }

  return { tools, stickyDelegation };
}

/** Só para testes. */
export function resetAll(): void {
  turns.clear();
  stickyNext.clear();
}
