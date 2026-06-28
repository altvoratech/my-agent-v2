// Subagentes nomeados que o agente principal (Ciel) pode invocar via a tool `Agent`.
// São READ-ONLY de propósito: exploram, revisam e planejam, e devolvem um relatório
// — quem escreve/edita é o agente principal (mantém o human-in-the-loop nas mutações).
// O Claude decide quando delegar pela `description` de cada um.
//
// Prompts vivem em src/prompts/subagent-*.md — editáveis sem tocar TypeScript.
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { CONSULTOR_TOOL } from "./consultor.ts";
import { loadPrompt } from "../prompts/loader.ts";

export const subagents: Record<string, AgentDefinition> = {
  explorer: {
    description:
      "Mapeia e explica o código ANTES de implementar. Use para entender a arquitetura, " +
      "localizar onde algo vive, traçar fluxos e dependências. Read-only, rápido.",
    tools: ["Read", "Glob", "Grep"],
    model: "haiku",
    prompt: loadPrompt('subagent-explorer'),
  },

  reviewer: {
    description:
      "Revisa código quanto a corretude e ao uso CORRETO das APIs/libs documentadas, " +
      "consultando a doc oficial via guardião (RAG ancorado no Neon). " +
      "Use para validar uma implementação. Read-only.",
    tools: ["Read", "Glob", "Grep", CONSULTOR_TOOL],
    model: "sonnet",
    prompt: loadPrompt('subagent-reviewer'),
  },

  planner: {
    description:
      "Planeja uma implementação ANTES de codar: passos, arquivos a tocar, riscos e ordem. " +
      "Não escreve código. Use para tarefas não-triviais que valem um plano.",
    tools: ["Read", "Glob", "Grep", CONSULTOR_TOOL],
    prompt: loadPrompt('subagent-planner'),
  },

  architect: {
    description:
      "Decide trade-offs de ARQUITETURA alto-nível (monolito vs serviços, escolha de banco, " +
      "estilo de API, escalabilidade, segurança) e escreve ADRs. Consultor read-only, não implementa.",
    tools: ["Read", "Glob", "Grep"],
    model: "opus",
    prompt: loadPrompt('subagent-architect'),
  },

  critic: {
    description:
      "Revisão de código GERAL (independente de framework): bugs, riscos, regressões e testes faltando. " +
      "Read-only, propõe correções mas não edita. Use para auditar uma mudança ou um arquivo.",
    tools: ["Read", "Glob", "Grep"],
    model: "sonnet",
    prompt: loadPrompt('subagent-critic'),
  },

  scribe: {
    description:
      "Rascunha documentação dev-facing (README, AGENTS.md, API docs, changelog, descrição de PR) lendo " +
      "o código/diff. Read-only: DEVOLVE o texto para o agente principal aplicar. Use para doc grande.",
    tools: ["Read", "Glob", "Grep"],
    model: "sonnet",
    prompt: loadPrompt('subagent-scribe'),
  },
};
