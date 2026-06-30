# ADR 0001 — Motor de Execução do Turno: estratégia multi-provider

**Status:** Proposto
**Data:** 2026-06-29
**Projeto:** my-agent-v2
**Autor:** Genildo / revisado por Axiom

---

## Contexto

`my-agent-v2` é um agente de engenharia de código local, single-user, escrito em TypeScript. O motor de execução de turnos é hoje exclusivamente o `@anthropic-ai/claude-agent-sdk`. O objetivo é suportar provedores alternativos (GPT-4o, Gemini, GLM etc.) sem sacrificar os invariantes de segurança que tornam a ferramenta utilizável como agente autônomo de código.

### Primitivas atualmente fornecidas pelo claude-agent-sdk

As seguintes capacidades estão diretamente acopladas ao SDK e são carregadas de valor:

| Primitiva | Onde vive | O que faz |
|-----------|-----------|-----------|
| `systemPrompt: { type:'preset', preset:'claude_code' }` | `src/agents/runtime.ts` | Injeta contexto de agente de código calibrado; modelos não-Claude não possuem equivalente |
| Hook **PreToolUse** + `permissionDecision` | `src/core/guard.ts` | Veta `rm -rf`, `.env` e escritas fora do cwd; roteia mutações para aprovação humana. É a **camada de segurança central** |
| `canUseTool` / `AskUserQuestion` | `src/agents/main-agent.ts` | Gate human-in-the-loop; a resposta retorna como `tool_result` na fila de streaming |
| Tool nativa `Agent`/`Task` | `src/agents/subagents.ts` | Orquestra explorer/reviewer/planner/architect/critic/scribe sem loop manual |
| `includePartialMessages` + `MessageQueue` | runtime / core | Streaming token-a-token com thinking parcial para dois frontends simultâneos (web + TUI) |
| `TodoWrite` nativo | integração com painel | Capturado pelo SDK e repassado ao painel de tarefas |
| MCP in-process | `consultor.ts` | RAG via `createSdkMcpServer` |

### Restrições do produto

- Local-first, single-user, sem deploy de produção.
- Dois frontends (React web + OpenTUI) compartilham o mesmo backend WebSocket.
- Segurança (guard de duas camadas + aprovação explícita) é um valor central, não uma feature opcional.

---

## Opções avaliadas

### Opção A — Gateway Anthropic-compat (LiteLLM ou similar)

Mantém o `claude-agent-sdk` sem alterações. Aponta `ANTHROPIC_BASE_URL` para um gateway que traduz chamadas Anthropic para o provedor alvo.

**Trade-offs:**

| Eixo | Avaliação |
|------|-----------|
| Esforço imediato | Muito baixo (1–2 dias de configuração) |
| Preservação da segurança | Total — guard, hooks e permissões funcionam sem mudança |
| Multi-provider real | Parcial: o gateway emula o protocolo Anthropic, incluindo tool-use e streaming, com qualidade variável por modelo |
| Preset `claude_code` | Propagado para todos os modelos, mas sem efeito semântico em modelos não-Claude; pode introduzir comportamento imprevisível |
| Manutenção | Dependência operacional de um processo de gateway; ponto extra de falha |
| Vendor lock-in | Continua preso ao contrato Anthropic; o gateway é um shim, não uma abstração real |
| Custo mensal | USD 0 (self-hosted LiteLLM) a ~USD 30 (serviço gerenciado); mais ~2 h/mês de manutenção do gateway |

**Problema central:** A Opção A não resolve o problema — ela o esconde. O `preset claude_code` enviado via gateway para o GPT-4o é ignorado ou mal interpretado. O streaming com `thinking` parcial depende de comportamento Anthropic-específico. Para providers que não emulam fielmente o protocolo (schema de erros, content blocks, tool-use), a degradação é silenciosa e difícil de depurar.

---

### Opção B — Trocar o motor pelo Vercel AI SDK

Substitui o `claude-agent-sdk` pelo `@ai-sdk/*` como motor canônico. Contrato unificado via `streamText` / `generateText` com parts `text | tool-call | reasoning | usage`. Catálogo via `models.dev`.

**O que precisa ser reimplementado à mão:**

| Primitiva perdida | Equivalente no Vercel AI SDK | Esforço estimado |
|-------------------|------------------------------|-----------------|
| Hook PreToolUse determinístico | Não existe. Requer loop manual com interceção antes de `execute()` | Alto (é a camada de segurança; erro aqui é crítico) |
| `permissionDecision: 'ask'/'deny'` | Não existe. Requer estado externo + prompt de aprovação manual | Médio-alto |
| `AskUserQuestion` como tool nativa com resposta via `tool_result` | Não existe. Requer um mecanismo de suspensão/retomada do loop | Alto |
| Orquestração de subagentes via tool `Agent`/`Task` | Não existe como primitiva; requer implementação manual de multi-agent loop | Alto |
| `includePartialMessages` + thinking parcial | Parcialmente coberto por `fullStream`, mas sem o modelo de thinking do Claude | Médio |
| `TodoWrite` nativo | Inexistente; requer tool customizada + parsing | Baixo |
| MCP in-process via `createSdkMcpServer` | Suportado via `experimental_createMCPClient`, mas contrato diferente | Médio |

**Estimativa total de reescrita:** 3–5 semanas de trabalho focado, com risco elevado na reimplementação do guard — que hoje é o único controle que impede o agente de executar operações destrutivas sem aprovação.

**Trade-offs:**

| Eixo | Avaliação |
|------|-----------|
| Multi-provider real | Sim — abstração genuína, qualidade por adaptador |
| Preservação da segurança | Em risco durante a reescrita; a nova implementação precisa de testes extensivos antes de ser confiável |
| Esforço | Muito alto para um projeto single-user/pessoal |
| Subagentes | Perde orquestração nativa; requer loop manual equivalente |
| Risco de regressão | Alto — reescreve o núcleo de um agente que já funciona |

**Problema central:** Para um projeto pessoal single-user, o custo da Opção B só se justifica se o ganho de multi-provider for operacionalmente crítico. Hoje não é.

---

### Opção C — Interface `Engine` interna com adapter Claude (recomendada)

Introduz uma interface TypeScript estreita (`Engine`) que encapsula o contrato de execução de um turno. O `claude-agent-sdk` vira o `ClaudeAgentSdkEngine`, primeiro (e por ora único) adapter. O guard permanece **acima** da interface, agnóstico de engine.

```typescript
// Esboço da interface
interface TurnOptions {
  messages: CoreMessage[];
  tools: ToolDefinition[];
  systemPrompt: string;
  signal?: AbortSignal;
}

interface TurnResult {
  stream: AsyncIterable<TurnPart>;   // text | tool-call | reasoning | usage
}

interface Engine {
  execute(options: TurnOptions): Promise<TurnResult>;
}
```

O guard intercepta `tool-call` parts **antes** de repassá-las ao executor de tool — independente de qual engine emitiu o evento. Isso preserva a camada de segurança sem acoplamento ao SDK.

**O que muda agora:**
- `src/agents/runtime.ts` encapsula `query()` do SDK dentro de `ClaudeAgentSdkEngine`.
- `src/core/guard.ts` opera sobre `TurnPart`, não sobre o hook proprietário — mas a lógica de veto permanece idêntica.
- Os subagentes continuam usando a tool `Agent` nativa via `ClaudeAgentSdkEngine`. Quando um segundo adapter for necessário, a orquestração de subagentes será reimplementada apenas para esse adapter.

**O que não muda:**
- Lógica de segurança, aprovação humana, AskUserQuestion, streaming, TUI, subagentes — tudo preservado.

**Custo imediato:** 3–5 dias para extrair a interface e refatorar `runtime.ts` e `main-agent.ts` sem alterar comportamento.

**Custo de adicionar um segundo adapter (futuro):** 1–2 semanas por adapter, sem risco para a engine Claude existente.

---

## Matriz de trade-offs comparativa

| Critério | Peso | Opção A (Gateway) | Opção B (Vercel AI SDK) | Opção C (Engine interface) |
|----------|------|-------------------|------------------------|---------------------------|
| Preservação da segurança | 30% | 5/5 | 2/5 (risco de reescrita) | 5/5 |
| Esforço de implementação | 25% | 5/5 | 1/5 | 4/5 |
| Multi-provider real | 20% | 2/5 (shim, não abstração) | 5/5 | 4/5 (paga quando precisar) |
| Risco de regressão | 15% | 2/5 (silencioso) | 3/5 | 5/5 (zero regressão imediata) |
| Manutenibilidade futura | 10% | 2/5 | 4/5 | 4/5 |
| **Score ponderado** | | **3,35** | **2,55** | **4,55** |

---

## Recomendação

**Adotar a Opção C — Interface `Engine` interna com `ClaudeAgentSdkEngine` como implementação inicial.**

A Opção C é a única que resolve o problema real sem criar um novo: ela abre a porta para multi-provider sem reescrever a camada de segurança que justifica a existência do produto. A Opção A é uma ilusão de multi-provider — o gateway emula o protocolo, não o comportamento. A Opção B tem o custo correto para um produto de time com pressão de mercado; para uma ferramenta pessoal single-user, o retorno não justifica 3–5 semanas de reescrita de código de segurança.

**Razões secundárias:**

- A interface `Engine` estreita tem menos de 50 linhas; o adapter Claude tem talvez 150. A abstração paga o próprio custo em legibilidade, independente de multi-provider.
- Manter o guard acima da interface elimina o risco de um adapter futuro "esquecer" de implementar segurança. A segurança deixa de ser responsabilidade do motor e passa a ser responsabilidade da orquestração.
- Providers realmente distintos do Claude (GPT-4o, Gemini) têm comportamentos de tool-calling e streaming suficientemente diferentes para que um gateway emulador seja mais perigoso que útil — a Opção C exige um adapter explícito por provider, o que força a testagem real.

**O que a recomendação cede:**

- Não entrega multi-provider imediatamente. O `ClaudeAgentSdkEngine` é o único adapter no curto prazo.
- Um segundo adapter (ex.: `VercelAiSdkEngine` para Gemini) ainda exige reimplementar subagentes e AskUserQuestion para aquele contexto — isso não desaparece, apenas é adiado e isolado.

---

## Consequências

**Positivas:**
- Zero regressão funcional. Nenhuma primitiva existente é removida ou reescrita neste ADR.
- O guard passa a ser engine-agnóstico. Qualquer adapter futuro recebe proteção automaticamente.
- A interface documenta o contrato do motor para futuros contribuidores (ou para o próprio autor em seis meses).
- O caminho para um `VercelAiSdkEngine` está aberto e é incremental — pode ser implementado em paralelo sem risco para a engine ativa.

**Negativas:**
- Adiciona uma camada de indireção onde antes havia chamada direta. O custo é mínimo, mas existe.
- O adapter Claude precisa preservar `includePartialMessages` e o thinking parcial — requer atenção na modelagem das `TurnPart`.
- Subagentes via tool `Agent` continuam sendo primitiva do `ClaudeAgentSdkEngine`; um futuro adapter não-Claude precisará de um mecanismo equivalente implementado à mão, o que é esforço real que este ADR apenas adia.

---

## Critérios de revisão deste ADR

Este ADR deve ser revisado quando **qualquer** das seguintes condições ocorrer:

1. Existe uma necessidade operacional concreta de rodar um modelo não-Claude (ex.: custo por token, capacidade específica como `o3-mini` para raciocínio longo, ou acesso offline com modelo local via Ollama).
2. O `claude-agent-sdk` introduz uma breaking change que força refatoração de `runtime.ts` de qualquer forma — momento ideal para implementar o segundo adapter.
3. O projeto migra de single-user para multi-user ou recebe um segundo contribuidor, ponto em que a abstração da interface paga dividendos maiores.

---

## Próximos passos (se adotado)

1. **Definir `src/engine/engine.ts`** — interface `Engine`, tipos `TurnOptions`, `TurnResult`, `TurnPart` (union de `TextPart | ToolCallPart | ReasoningPart | UsagePart | ErrorPart`).
2. **Criar `src/engine/adapters/claude-agent-sdk.ts`** — `ClaudeAgentSdkEngine` encapsulando `query()` de `runtime.ts`. A lógica de `buildAgentOptions` e o preset `claude_code` ficam encapsulados aqui.
3. **Refatorar `src/core/guard.ts`** — substituir dependência do hook `PreToolUse` do SDK por interceção sobre `ToolCallPart` emitido pelo stream. A lógica de veto (`rm -rf`, `.env`, cwd boundary) permanece idêntica.
4. **Atualizar `src/agents/main-agent.ts`** — `canUseTool` e `AskUserQuestion` operam sobre `ToolCallPart`; a resolução de `tool_result` segue via `MessageQueue` existente.
5. **Testes de contrato:** verificar que o guard veta os mesmos casos antes e depois da refatoração, com testes unitários sobre `TurnPart` mockados.
6. **Documentar no README** o registro do adapter ativo e o passo-a-passo para adicionar um segundo adapter.

---

## Referências

- `src/agents/runtime.ts` — `buildAgentOptions`, acoplamento ao tipo `Parameters<typeof query>`
- `src/core/guard.ts` — hook `PreToolUse`, `permissionDecision`
- `src/agents/main-agent.ts` — `canUseTool`, `AskUserQuestion`, `MessageQueue`
- `src/agents/subagents.ts` — orquestração via tool `Agent`/`Task`
- `src/agents/consultor.ts` — MCP in-process via `createSdkMcpServer`
- [Vercel AI SDK — `streamText` / parts contract](https://sdk.vercel.ai/docs/reference/ai-sdk-core/stream-text)
- [models.dev — catálogo de providers](https://models.dev)
