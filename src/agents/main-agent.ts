// Definição do AGENTE PRINCIPAL (Ciel) — o orquestrador que o chat web conversa.
// Aqui mora o DOMÍNIO do agente: system prompt, tools, subagentes especialistas e a
// política de aprovação (human-in-the-loop). O TRANSPORTE da sessão (MessageQueue +
// AgentSession, streaming-input mode) fica em web/server/ai-client.ts.
//
// Prompts vivem em src/prompts/*.md — editáveis sem tocar TypeScript.
// No futuro multi-provider: o chamador decide se usa preset+append (Claude)
// ou rawPrompt string (outros via Vercel AI SDK) sem mudar o conteúdo do .md.
import { consultorServer, CONSULTOR_TOOL } from './consultor.ts';
import { subagents } from './subagents.ts';
import { createGuardedHooks } from '../core/guard.ts';
import { buildAgentOptions } from './runtime.ts';
import { loadPrompt } from '../prompts/loader.ts';

export function buildSystemPrompt(cwd: string) {
  return loadPrompt('ciel', { cwd })
}

// Ações que mexem no sistema -> pedem confirmação humana via canUseTool.
const NEEDS_APPROVAL = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit']);

export type ApprovalFn = (req: { tool: string; input: any }) => Promise<boolean>;

// Formato da tool nativa AskUserQuestion (ver sources/user-input.md).
export interface AskQuestionOption { label: string; description?: string; }
export interface AskQuestionItem {
  question: string;
  header?: string;
  options?: AskQuestionOption[];
  multiSelect?: boolean;
}
// Recebe as perguntas geradas pelo Claude, devolve { [texto da pergunta]: label(s) }.
export type QuestionFn = (questions: AskQuestionItem[]) => Promise<Record<string, string>>;

export interface MainAgentParams {
  model: string;
  cwd: string;
  effort?: string;
  onApproval?: ApprovalFn;
  onQuestion?: QuestionFn;
}

// Monta as `options` do query() do agente principal (tudo menos o prompt/queue — isso é
// transporte). Recebe o onApproval (callback que pergunta ao browser) por injeção.
// O scaffolding comum (preset, permissionMode, stream) vem de buildAgentOptions.
export function buildMainAgentOptions({ model, cwd, effort, onApproval, onQuestion }: MainAgentParams) {
  return buildAgentOptions({
    model,
    cwd,
    effort,
    maxTurns: 200,
    stream: true, // emite stream_event para o front renderizar token a token
    prompt: buildSystemPrompt(cwd),
    mcpServers: { consultor: consultorServer },
    // subagentes especialistas (read-only) que o agente principal invoca via Agent
    agents: subagents,
    // leitura + delegação pré-aprovadas; escrita/exec caem no canUseTool (default mode).
    // AskUserQuestion NÃO entra aqui de propósito: o guard a marca como 'ask' p/ cair no
    // canUseTool, onde a pergunta é resolvida (user-input.md). Pré-aprovar pularia isso.
    allowedTools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Agent', 'Task', CONSULTOR_TOOL],
    // guard veta o destrutivo e encaminha mutações ao canUseTool (askOnMutate)
    hooks: createGuardedHooks(cwd, { askOnMutate: true }),
    canUseTool: async (toolName, input) => {
      // Perguntas de esclarecimento: o SDK resolve AskUserQuestion AQUI, não no stream.
      // Transmitimos as questions ao browser, esperamos a resposta e devolvemos
      // updatedInput com { questions, answers } — formato exigido pela tool.
      if (toolName === 'AskUserQuestion' && onQuestion) {
        const questions = (input as { questions?: AskQuestionItem[] }).questions ?? [];
        const answers = await onQuestion(questions);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      if (!NEEDS_APPROVAL.has(toolName) || !onApproval) {
        return { behavior: 'allow', updatedInput: input };
      }
      const ok = await onApproval({ tool: toolName, input });
      return ok
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Ação recusada pelo usuário.' };
    },
  });
}
