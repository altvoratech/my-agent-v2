// Server MCP in-process que expõe o guardião como uma tool consultável por
// outros agentes (agent.ts, reviewer.ts). É o ponto de ENCADEAMENTO: o handler
// chama askGuardian(), que roda o loop do guardião contra o Neon.
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { askGuardian } from './guardian.ts';
import { log } from '../core/logger.ts';

const consultarGuardian = tool(
  'consultar_guardian',
  'Pesquisa ANCORADA na base de documentação indexada no Neon/pgvector (catálogo em sources/manifest.json). O guardião faz retrieval semântico e responde SÓ com base nas fontes, citando-as; se algo não estiver coberto, diz que não encontrou. Use para confirmar como uma API/lib DEVE ser usada segundo a doc oficial, em vez de confiar na memória — ele devolve só a resposta ancorada, sem despejar os chunks no teu contexto. NA DÚVIDA, consulte: o custo de tentar é baixo.',
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
