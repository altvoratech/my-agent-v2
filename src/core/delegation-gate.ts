// Portão de delegação: audita, no fim do turno, se o agente principal fez
// trabalho de leitura pesado SEM delegar ao subagente explorer (haiku).
// Ver docs/superpowers/specs/2026-07-25-portao-delegacao-design.md

import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildAgentOptions } from '../agents/runtime.ts';
import { log } from './logger.ts';

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

  try {
    let text = '';
    let costUsd: number | undefined;
    for await (const msg of query({
      prompt:
        `FERRAMENTAS USADAS NO TURNO (lista real): ${summary}\n` +
        `Total de tool calls: ${tools.length}. Delegou (Agent/Task/Skill)? NÃO.\n\n` +
        `Decida se devia ter delegado. Responda só o JSON.`,
      options: buildAgentOptions({
        prompt: JUDGE_SYSTEM,
        rawPrompt: true,
        model: 'haiku',
        maxTurns: 1,
        allowedTools: [],
        settingSources: [], // agente limpo: sem MCP/skills do usuário
      }),
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') text += block.text;
        }
      } else if (msg.type === 'result' && 'total_cost_usd' in msg) {
        costUsd = msg.total_cost_usd;
      }
    }
    const verdict = parseVerdict(text);
    return verdict ? { ...verdict, costUsd } : null;
  } catch (err) {
    await log.warn('gate.judge_error', { error: String(err) });
    return null; // fail-open
  }
}
