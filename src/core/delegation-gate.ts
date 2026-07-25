// Portão de delegação: audita, no fim do turno, se o agente principal fez
// trabalho de leitura pesado SEM delegar ao subagente explorer (haiku).
// Ver docs/portao-delegacao.md

import type { HookCallback, StopHookInput } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildAgentOptions } from '../agents/runtime.ts';
import { log } from './logger.ts';
import { takeTurn } from './turn-tracker.ts';

/** Invocar qualquer uma destas conta como delegação de verdade. */
export const DELEGATION_TOOLS = new Set(['Agent', 'Task', 'Skill']);

/** Tools que representam trabalho de pesquisa/edição — o que se quer delegar. */
export const HEAVY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit',
]);

/** Valor de partida herdado de um auditor de referência externo. A medir, não presumir. */
export const HEAVY_THRESHOLD = 6;

/**
 * Deadline do juiz (C1 da revisão final). Duas redes independentes:
 * 1. Dentro de judge(): AbortController aborta o query() do SDK ao estourar o prazo.
 * 2. Dentro do gate: Promise.race entre a chamada a judgeFn (real ou injetada em
 *    teste) e um timer — cobre qualquer judgeFn que pendure, mesmo que ela não
 *    respeite AbortController nenhum (ex: dublê de teste). Estourou -> null -> libera.
 */
/** Prazo do juiz. MEDIDO em 2026-07-25 com o e2e real: a mesma chamada leva
 * ~2 s isolada e 17-23 s quando feita de dentro do hook Stop de outro query()
 * — a reentrância custa 8-11x. Os 8 s originais abortavam sempre. 30 s cobre o
 * caso que funciona e corta o que trava (1 de 3 rodadas passou de 90 s).
 * Ajustável por env para medir de novo sem editar código. */
export const JUDGE_TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS ?? 30_000);

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

export interface JudgeVerdict {
  ok: boolean;
  reason?: string;
  costUsd?: number;
}

const JUDGE_SYSTEM = `Você é um auditor de DELEGAÇÃO, leve e objetivo. Decide se o
agente principal DEVIA ter delegado ao subagente "explorer" (leitura de código,
read-only, barato) e NÃO delegou. Você recebe a LISTA REAL de ferramentas que ele
usou no turno — dado de fato, não suposição.

Responda com UM objeto JSON e NADA mais:
{"ok": true}   ou   {"ok": false, "reason": "<o que delegar>"}

Responda {"ok": true} se o turno foi conversa, relato, ou edição pontual guiada
por leitura que o próprio agente já tinha em contexto. Em QUALQUER dúvida, ok:true.

Responda {"ok": false} só quando for inequívoco: varredura ampla de arquivos que
o subagente explorer teria feito por uma fração do custo.`;

/** Extrai o veredito do texto do juiz. Exportada para teste. */
export function parseVerdict(text: string): JudgeVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { ok?: unknown; reason?: unknown };
    if (typeof parsed.ok !== 'boolean') return null;
    return { ok: parsed.ok, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined };
  } catch {
    return null;
  }
}

export async function judge(tools: string[]): Promise<JudgeVerdict | null> {
  const counts = tools.reduce<Record<string, number>>((acc, t) => {
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts).map(([n, c]) => `${n}x${c}`).join(', ');
  const t0 = Date.now();

  // Rede 1: AbortController com deadline próprio, passado ao query() do SDK.
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), JUDGE_TIMEOUT_MS);

  try {
    let text = '';
    let costUsd: number | undefined;
    for await (const msg of query({
      prompt:
        `FERRAMENTAS USADAS NO TURNO (lista real): ${summary}\n` +
        `Total de tool calls: ${tools.length}. Delegou (Agent/Task/Skill)? NÃO.\n\n` +
        `Decida se devia ter delegado. Responda só o JSON.`,
      options: {
        ...buildAgentOptions({
          prompt: JUDGE_SYSTEM,
          rawPrompt: true,
          model: 'haiku',
          maxTurns: 1,
          allowedTools: [],
          settingSources: [], // agente limpo: sem MCP/skills do usuário
        }),
        abortController,
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text;
        }
      } else if (msg.type === 'result' && 'total_cost_usd' in msg) {
        costUsd = msg.total_cost_usd;
      }
    }
    await log.info('gate.judge_ms', { ms: Date.now() - t0, ok: text.length > 0 });
    const verdict = parseVerdict(text);
    return verdict ? { ...verdict, costUsd } : null;
  } catch (err) {
    await log.warn('gate.judge_error', { error: String(err), ms: Date.now() - t0 });
    return null; // fail-open (inclui abort por timeout)
  } finally {
    clearTimeout(abortTimer);
  }
}

/** Corre `promise` contra um timer; estourou o prazo -> resolve null (fail-open).
 * Rede 2 do C1: cobre qualquer judgeFn (real ou dublê de teste) que pendure,
 * independente do AbortController interno de judge(). */
function raceWithDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface DelegationAuditInput {
  toolCounts: string;
  heavyCount: number;
  delegated: 0 | 1;
  layer: 'deterministic' | 'judge';
  verdict: 'allow' | 'block';
  reason: string | null;
  judgeCostUsd: number | null;
}

export interface GateDeps {
  /** grava a decisão; injetado de fora para não acoplar src/core a web/ */
  onAudit?: (row: DelegationAuditInput) => void;
  /** substituível em teste */
  judgeFn?: (tools: string[]) => Promise<JudgeVerdict | null>;
  /** false = modo observação: grava mas nunca bloqueia */
  enabled?: boolean;
}

/** Contagem por tool, serializada com as chaves em ordem ALFABÉTICA.
 *
 * A ordenação é o que torna o valor canônico: sem ela, `[Read, Grep]` e
 * `[Grep, Read]` — a mesma carga de trabalho — geram strings diferentes, e
 * qualquer `GROUP BY toolCounts` fragmenta em linhas que deviam ser uma só.
 * O propósito da tabela `delegation_audits` é justamente ser agrupada. */
export function countOf(tools: string[]): string {
  const counts = tools.reduce<Record<string, number>>((acc, t) => {
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  const canonical: Record<string, number> = {};
  for (const name of Object.keys(counts).sort()) canonical[name] = counts[name];
  return JSON.stringify(canonical);
}

export function createDelegationGate(deps: GateDeps = {}): HookCallback {
  const judgeFn = deps.judgeFn ?? judge;
  const enabled = deps.enabled ?? true;

  return async (input) => {
    try {
      const stop = input as StopHookInput;
      const { tools, stickyDelegation } = takeTurn(stop.session_id);

      // anti-loop: já bloqueamos uma vez neste turno -> deixa parar
      if (stop.stop_hook_active) return {};

      const raw = classifyTurn(tools);
      // delegação pegajosa do turno anterior conta como delegação (spec §7 item 4)
      const delegated = raw.delegated || stickyDelegation;
      const heavy = raw.heavy;
      const ambiguous = raw.ambiguous && !stickyDelegation;
      const base = {
        toolCounts: countOf(tools),
        heavyCount: heavy,
        delegated: (delegated ? 1 : 0) as 0 | 1,
      };

      if (!ambiguous) {
        deps.onAudit?.({
          ...base, layer: 'deterministic', verdict: 'allow', reason: null, judgeCostUsd: null,
        });
        return {};
      }

      let verdict: JudgeVerdict | null = null;
      try {
        verdict = await raceWithDeadline(judgeFn(tools), JUDGE_TIMEOUT_MS);
      } catch {
        deps.onAudit?.({
          ...base, layer: 'judge', verdict: 'allow', reason: 'judge_error', judgeCostUsd: null,
        });
        return {};
      }
      if (!verdict || verdict.ok) {
        deps.onAudit?.({
          ...base, layer: 'judge', verdict: 'allow', reason: null,
          judgeCostUsd: verdict?.costUsd ?? null,
        });
        return {};
      }

      const reason = verdict.reason ??
        'Este turno fez leitura pesada sem delegar. Use o subagente explorer (haiku, read-only) para mapear o código.';
      deps.onAudit?.({
        ...base, layer: 'judge', verdict: 'block', reason, judgeCostUsd: verdict.costUsd ?? null,
      });

      return enabled ? { decision: 'block', reason } : {};
    } catch (err) {
      void log.warn('gate.error', { error: String(err) }).catch(() => {});
      return {}; // fail-open
    }
  };
}
