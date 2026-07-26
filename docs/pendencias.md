# Pendências

Trabalho em aberto, com o contexto necessário para retomar sem re-descobrir.
Atualizado em **2026-07-25**. Ordenado por impacto, não por esforço.

O que está **decidido e feito** vive no [CHANGELOG](../CHANGELOG.md). O que a
suíte prova está em [`testes/`](../testes/). Este arquivo é só o que falta.

---

## 1. Prompts — o fio principal

**Objetivo declarado:** melhorar os prompts. Os `.md` atuais não agradam; a ideia
é pegar como referência o formato YAML que a plataforma da Anthropic usa para
definir agentes.

### O que existe hoje

| Prompt | Onde | Tamanho |
|---|---|---|
| Ciel (agente principal) | `src/prompts/ciel.md` | 24 linhas |
| Subagentes | `src/agents/subagents.ts` (inline) | 6 definições |
| Juiz do portão | `src/core/delegation-gate.ts` → `JUDGE_SYSTEM` | inline |
| Guardião | `src/agents/guardian.ts` | inline |
| Enhancer | `src/agents/enhance.ts` | inline |
| Tester | `src/agents/tester.ts` → `TESTER_SYSTEM` | inline |

O `loadPrompt()` (`src/prompts/loader.ts`) já separa conteúdo de código e faz
substituição de `{{chave}}`. Só o `ciel.md` usa; o resto é string no `.ts`.

### O que descobrir antes de mexer

**O `ciel.md` não é o system prompt — é um `append`.** `src/agents/runtime.ts:55-57`:

```ts
systemPrompt: spec.rawPrompt
  ? spec.prompt
  : { type: 'preset', preset: 'claude_code', append: spec.prompt }
```

Ou seja, o agente é **Claude Code + `ciel.md` colado no fim**. Isso veio no
commit raiz (`c4c0b23`), herdado do demo — nunca foi uma decisão. Reescrever o
prompt sem decidir isto é ajustar uma variável enquanto a outra se move.

`rawPrompt: true` já existe no `AgentSpec` e é usado pelo enhancer. Trocar para
`raw` no agente principal dá identidade própria e **custa** as convenções de uso
de ferramenta que o preset carrega — o `ciel.md` hoje é escrito para
*complementar* o preset, não para substituí-lo.

### Correção que vai junto de qualquer jeito

O `JUDGE_SYSTEM` faz o juiz citar **`Explore`**, mas o subagente deste repo se
chama **`explorer`** (`src/agents/subagents.ts`). Medido na primeira execução
real do e2e: a lacuna devolvida foi *"delegue ao Explore"*. Em modo observação é
cosmético; com `DELEGATION_GATE=on` o modelo recebe instrução para chamar um
subagente que não existe.

---

## 2. Portão de delegação — cinco decisões do dono

As quatro primeiras vieram da revisão final de branch; a quinta foi levantada
depois que o e2e rodou. Nenhuma é bug — todas são escolhas.

**2.1 `HEAVY_TOOLS` inclui `Bash`/`Edit`/`Write`.** Esses três somam 137 das 265
chamadas medidas. Um turno normal de implementação (6 `Bash` + 2 `Edit`) vira
ambíguo e sobe ao juiz, que é perguntado se deveria ter delegado *edições* ao
`explorer` — um subagente **read-only**. Alternativa: contar só `Read`/`Grep`/`Glob`.

**2.2 O modo observação paga o juiz.** `DELEGATION_GATE=on` liga o bloqueio, mas
não existe valor que desligue a camada 2 — no default o juiz roda em todo turno
ambíguo, custando haiku e latência. Sugestão: três estados `off`/`observe`/`on`.

**2.3 `judge(tools)` não recebe o pedido do usuário.** O spec original pedia
`judge(userPrompt, tools)`. O juiz vê `Read x8` e nada mais: *"leia estes 8
arquivos"* e *"descubra onde mora X"* são indistinguíveis. É a maior fonte de
falso positivo do desenho, e `StopHookInput.last_assistant_message` está
disponível de graça.

**2.4 `followedUp` é coluna morta.** Existe no schema, não está no `INSERT`, e o
turno que responderia a pergunta (aquele em que o agente reage ao bloqueio)
retorna cedo pelo caminho anti-loop sem gravar — com a lacuna cristalizada num
teste que asserta `onAudit` **não** foi chamado. Ou grava, ou tira a coluna.

**2.5 O juiz segura o turno mesmo quando o veredito não muda nada.** *(a mais
importante das cinco, na minha avaliação — as outras afetam a qualidade do dado,
esta afeta quem usa a ferramenta.)* Em modo observação o veredito só é gravado,
mas o juiz roda **síncrono** e trava o fechamento do turno por até 30 s. Com
1 chamada em 3 não retornando, isso é meio minuto de espera para não produzir
nada. Proposta: assíncrono quando `DELEGATION_GATE != 'on'`.

---

## 3. Superfície do agente — herança não decidida

**Medido em 2026-07-25** com sonda no evento `system/init`, comparando o mesmo
minuto na mesma máquina:

| | my-agent-v2 | contêiner limpo |
|---|---|---|
| tools | **61** | 23 |
| tools MCP | **28** (12 servidores) | 0 |
| plugins | 25 | 0 |

`buildMainAgentOptions` **não passa `settingSources`**, e `runtime.ts:63` só
inclui a chave se ela existir — então o SDK aplica o default, que é carregar
tudo: `~/.claude/settings.json`, o `.claude/` do projeto onde o agente roda, e os
`CLAUDE.md`. Rodando no blense, o Ciel carrega o agente e as 4 skills **daquele
projeto**, mais o CLAUDE.md global do dono.

Três alavancas, do bisturi ao absoluto:

| Opção | Efeito medido |
|---|---|
| `strictMcpConfig: true` | só os MCP passados em `mcpServers` — mataria os 28 herdados sem tocar em mais nada. **Não está exposto no `AgentSpec`.** |
| `settingSources: []` | 61 → 40 tools; **não** remove os conectores `claude_ai_*` nem o `ToolSearch` (parte do MCP mora em `~/.claude.json`, que não é um `settings.json`) |
| `CLAUDE_CONFIG_DIR=<dir>` | realoca o `~/.claude` inteiro; testado — o diretório novo é populado e a autenticação some junto (`Not logged in`) |

**Trade-off real:** com o cinto fechado o Ciel perde `recall`, `codegraph` e as
skills. O insight central do projeto foi *"o harness do Ciel está no `~/.claude`"* —
essa herança pode estar servindo. Decisão do dono.

Nota lateral: `allowedTools` **não** restringe o cinto — é lista de
pré-aprovação. Confirmado no cookbook oficial (o agente deles declara
`["WebSearch"]` e o `init` reporta 23 tools).

---

## 4. Guardião — medir em vez de esperar

A description da tool passou a nomear os grupos indexados (commit `035eaa9`),
mas **a correção foi feita no escuro**: para saber se funcionou, o plano era usar
por uma semana.

O instrumento para medir isso existe pronto e não estava sendo usado:

- **`skill-creator`** (instalado): `scripts/run_eval.py`, `improve_description.py`;
  método em `SKILL.md` §335-356 — 20 queries `{query, should_trigger}`, metade
  deve acionar e metade não (as *near-misses* são as mais valiosas). Roda via
  `claude -p` **reusando a auth da sessão**, sem API key.
- **`tool_evaluation`** do `claude-cookbooks`: o mesmo para **tools MCP**, e
  acrescenta um bloco `<feedback>` em que o modelo critica nome e description da
  própria ferramenta.

Contexto que justifica: `consultar_guardian` foi chamada **0 vezes em 323**. Nos
logs do teste no blense, o agente *tentou* — `ToolSearch`, depois
`cat sources/manifest.json` — e desistiu porque a base não cobria o assunto.

Ativo registrado em `~/Documentos/ativos/ativo-medir-acionamento-de-tool-e-skill.md`.

---

## 5. Radix Themes — integrado, não usado

`@radix-ui/themes@3.3.0` está instalado e fiado no **web chat** (o TUI não foi
tocado). A UI está idêntica à de antes: o Radix está **disponível**, não usado.

**O que já está de pé:**

- `web/client/globals.css` — cascata explícita
  `@layer tw-base, radix, tw-components, tw-utilities`, com o Radix importado
  dentro da sua camada. A doc oficial avisa que o Tailwind v3 acrescenta os
  estilos do `@tailwind` **depois** do CSS importado, então o reset de botão do
  preflight passaria por cima dos componentes do Radix. Das três saídas que a
  doc dá (não usar `@tailwind base` / camadas / `postcss-import`), camadas foi a
  escolhida: as outras duas custam algo — sem preflight o CSS atual muda de
  comportamento, e `postcss-import` traz ferramenta nova.
- `web/client/index.tsx` — `<Theme appearance="light" accentColor="indigo"
  grayColor="slate" radius="medium">` na **entrada**, não no `App`, para alcançar
  os portais dos modais. É ali que se ajusta a identidade visual.
- Verificado no CSS compilado: a diretiva `@layer` na ordem certa, o bloco
  `@layer radix{…}` e os tokens `--accent-9` / `--gray-1` / `--radius-3`.
  Build 3,7 s, typecheck limpo, 138 testes verdes.

**A decisão que falta**, e que muda o tamanho do diff:

| | |
|---|---|
| **Só os tokens** | usar as CSS vars do Radix nas classes Tailwind que já existem — diff pequeno, ganho de coerência, risco zero |
| **Componentes** | `Button`/`Card`/`Dialog`/`TextField` substituindo markup nos 16 `.tsx` |

Se for componentes, **fazer piloto antes de espalhar**: `SettingsModal`
(190 linhas) ou `ApprovalModal` são os candidatos fechados. E vale **delegar** —
o Stop hook do auditor bloqueou a tentativa de fazer isso no loop principal
(*"múltiplos arquivos/integração de feature → Task"*), com razão.

Contexto do cliente para quem for mexer: 16 `.tsx`, ~2.000 linhas de UI,
Tailwind 3 utilitário puro, **zero** classes `dark:` (a UI é só light),
`@tailwindcss/typography` no prose, Shiki com estilo inline, `sonner` para toast,
`lucide-react` para ícones. **Não existe teste de UI** — só `toolPanelGrouping`,
que é função pura. A verificação é visual.

---

## 6. Dívida conhecida

**Causa-raiz do travamento 1-em-3 do juiz.** Medido: a mesma chamada haiku leva
~2 s isolada, 17–23 s de dentro do hook `Stop`, e 1 rodada em 3 não respondeu em
90 s. Os 30 s de timeout cortam o prejuízo, **não a causa**. Amostra de 3 —
vale repetir para confirmar a taxa. Hipótese: contenção ao criar um segundo
processo do CLI enquanto o primeiro fecha o turno.

**Catálogo de modelos duplicado em três arquivos.**
`web/client/components/chat/constants.ts` (`id` + `CONTEXT_WINDOW`),
`tui/data.ts` (`value`), `tui/screens/ChatScreen.tsx` (`MODEL_CTX`, dentro de um
componente). Só um comentário os mantém em sincronia, e isso já falhou: a
correção 200k → 1M teve de ser feita duas vezes. Pergunta anterior à unificação:
**por que a janela de contexto está chumbada no cliente**, se o servidor sabe
qual modelo instanciou? Restrição: nenhum cliente importa de `src/` hoje, e o
Vite tem `root: "client"`.

**`log.warn` na falha silenciosa de FK.** Um `chatId` inexistente faz o `INSERT`
em `delegation_audits` lançar; o fail-open engole e a auditoria some sem log.

**Conflito `solid-js` 1.9.12 × 1.9.13.** `@opentui/solid@0.4.2` declara
peerDependency `solid-js` **exatamente** `1.9.12`; o projeto tem `1.9.13`. O TUI
funciona, mas qualquer `npm install` que re-resolva a árvore falha com `ERESOLVE`
e exige `--legacy-peer-deps` (foi o caminho usado para instalar o Radix, sem
tocar no `solid-js`). Opções: fixar em 1.9.12, atualizar o `@opentui/solid`, ou
criar um `.npmrc` documentando a escolha em vez de depender de lembrar da flag.

**Tipar os 12 `any` da camada WS.** `web/server/session.ts`,
`web/client/lib/api.ts`, `hooks/useAgentSocket.ts`.

**Abrir issues no repo público.** O `CONTRIBUTING.md` já aponta para "as issues",
e hoje esse ponteiro aponta para o vazio. Candidatas com contexto suficiente:
testar `session.ts`/`ai-client.ts`, `log.warn` do FK, e o motor multi-provider
(ADR 0001).

---

## 7. ADR 0001 — uma quarta opção não considerada

A ADR descreve três caminhos para multi-provider e recomenda a Opção C
(interface `Engine`). Existe uma quarta que ela não menciona: **orquestrar
processos**. Um agente do Claude Agent SDK **é um processo** — está escrito na
documentação do cookbook — então rodar `opencode` (multi-provider, já instalado
nesta máquina) ao lado do `claude` dá multi-provider sem escrever adapter nenhum.

Custo de implementação: zero. **Custo real:** o `guard.ts` e o portão de
delegação não alcançam o que roda dentro de outro processo — você ganharia
multi-provider e perderia as duas camadas que definem o produto. Serve para
agente auxiliar, não para o loop principal.

Vale registrar na ADR: ela está pública e marcada como *"aberto a contribuição"*,
e quem ler hoje não sabe que essa opção existe.
