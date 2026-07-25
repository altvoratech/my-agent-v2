// Server MCP in-process que expõe o guardião como uma tool consultável por
// outros agentes (agent.ts, reviewer.ts). É o ponto de ENCADEAMENTO: o handler
// chama askGuardian(), que roda o loop do guardião contra o Neon.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { askGuardian } from './guardian.ts';
import { log } from '../core/logger.ts';

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '../../sources/manifest.json');

/** Nomes dos grupos indexados, lidos do manifesto. `[]` se o arquivo não existir. */
export function coveredTopics(manifestPath = MANIFEST): string[] {
  try {
    const groups = (JSON.parse(readFileSync(manifestPath, 'utf-8')) as { groups?: Record<string, unknown> }).groups;
    return groups ? Object.keys(groups).sort() : [];
  } catch {
    return []; // sem manifesto, a description cai no texto genérico
  }
}

/** O modelo não tem como saber o que está indexado sem abrir o manifesto — e gastar
 * uma tool call pra decidir se vale gastar outra faz ignorar sair mais barato que
 * consultar. Por isso o catálogo entra na própria description: dá pra decidir sem
 * round-trip, inclusive decidir NÃO chamar quando o assunto está fora da base. */
export function buildDescription(topics = coveredTopics()): string {
  const base =
    'Pesquisa ANCORADA na base de documentação indexada no Neon/pgvector. O guardião faz retrieval semântico e responde SÓ com base nas fontes, citando-as; se algo não estiver coberto, diz que não encontrou. Use para confirmar como uma API/lib DEVE ser usada segundo a doc oficial, em vez de confiar na memória — ele devolve só a resposta ancorada, sem despejar os chunks no teu contexto.';
  return topics.length
    ? `${base} COBRE HOJE, e somente isto: ${topics.join(', ')}. Se a pergunta for sobre um desses assuntos, consulte antes de responder de memória — o custo é baixo. Se for sobre qualquer outra coisa, NÃO chame: a base não tem, e a resposta será "não encontrei".`
    : `${base} Catálogo do que está indexado em sources/manifest.json. NA DÚVIDA, consulte: o custo de tentar é baixo.`;
}

const consultarGuardian = tool(
  'consultar_guardian',
  buildDescription(),
  {
    pergunta: z.string().describe('Pergunta em linguagem natural sobre qualquer biblioteca/doc indexada no Neon. Faça perguntas focadas para melhor recuperação.'),
  },
  async (args) => {
    const { answer, cost, turns } = await askGuardian(args.pergunta);
    await log.info('reviewer.consult', { pergunta: args.pergunta, turns, cost });
    return { content: [{ type: 'text', text: answer }] };
  },
  { annotations: { readOnlyHint: true } }, // consulta read-only -> permite consultas em paralelo
);

export const consultorServer = createSdkMcpServer({
  name: 'consultor',
  version: '1.0.0',
  tools: [consultarGuardian],
});

export const CONSULTOR_TOOL = 'mcp__consultor__consultar_guardian';
