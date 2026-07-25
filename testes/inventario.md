# Inventário — 138 casos em 8 arquivos

## Por área

| Área | Arquivo | Casos | Chama modelo? | Toca disco? |
|---|---|---:|---|---|
| Segurança | `src/core/guard.test.ts` | 20 | não | não |
| RAG (chunking) | `src/rag/chunker.test.ts` | 27 | não | não |
| Portão — unidade | `src/core/delegation-gate.test.ts` | 24 | não | não |
| Portão — acumulador | `src/core/turn-tracker.test.ts` | 7 | não | não |
| Portão — hook | `src/core/hooks.test.ts` | 2 | não | não |
| Portão — integração | `web/server/delegation-gate.integration.test.ts` | 6 | não (juiz stub) | SQLite `:memory:` |
| Store | `web/server/chat-store.test.ts` | 1 | não | SQLite `:memory:` |
| UI (agrupamento) | `web/client/components/toolPanelGrouping.test.ts` | 8 | não | não |
| **E2E (opt-in)** | `scripts/e2e-portao.ts` | — | **sim, haiku real** | banco temporário |

---

## `src/core/guard.test.ts` — 20 casos

A camada de segurança. É o único teste que protege contra dano real.

- **Bloqueio de `.env`** (3): raiz do projeto, caminho relativo, fora do projeto.
- **Fronteira do cwd** (6): permite dentro e em subpasta; nega fora, path traversal `../`, `/etc/passwd`, `/tmp/fora`.
- **`AskUserQuestion` sempre pergunta** (2): retorna `ask` mesmo com `askOnMutate=false` — não pode ser pré-aprovada.
- **Política `askOnMutate`** (7): `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` viram `ask`; `Read` não (não é mutante); sem a opção, `Write` seguro auto-libera.
- **Forma do retorno** (2): `deny` inclui `hook_event_name` e `permissionDecisionReason`; `createGuardedHooks` devolve `PreToolUse` e `PostToolUse`.

## `src/rag/chunker.test.ts` — 27 casos

O maior conjunto do projeto, e o mais antigo. Cobre `chunkMarkdown`/`splitUnits`.

- **Descartes** (4): vazio, só whitespace, abaixo de `MIN_CHUNK`, exatamente `MIN_CHUNK`.
- **Quebra por heading** (5): `#`, `##`, níveis 1–6; cada chunk começa com seu heading; `#sem-espaço` não é heading.
- **Code blocks** (6): bloco inteiro num chunk só; código colado à prosa anterior; código maior que `MAX_CHUNK` não é dividido; fence não fechada não explode; múltiplos blocos em ordem.
- **Limites** (4): prosa pura acima de `MAX_CHUNK` vira um chunk só (comportamento conhecido, documentado); bloco abaixo do máximo nunca é subdividido.
- **Invariantes** (4): determinismo, sem chunks vazios, tudo trimmado, sentinelas presentes.
- **Fixture realista** (3): produz chunks válidos, respeita `MAX_CHUNK` salvo código, preserva blocos `bash`/`env`.

## `src/core/delegation-gate.test.ts` — 20 casos

O núcleo do portão, em quatro blocos.

**`classifyTurn` — camada determinística (5)**
Turno leve não é ambíguo · turno que delegou não é ambíguo mesmo pesado · `Skill` conta como delegação · pesado sem delegação é ambíguo · tools não-pesadas não contam para o limiar.

**`countOf` — serialização canônica (4)**
Mesma carga em ordens diferentes gera a mesma string · chaves em ordem alfabética · conta repetições · turno vazio vira `{}`. Verificados por mutação: sem o `.sort()`, três dos quatro falham.

**`parseVerdict` — robustez do parsing (4)**
Extrai JSON com texto em volta · devolve `null` sem JSON, com JSON malformado, e quando `ok` não é booleano.

**`createDelegationGate` — orquestração (11)**
Libera sem chamar juiz em turno leve e em turno que delegou · bloqueia com a lacuna quando o juiz diz `ok:false` · **fail-open** quando o juiz lança, devolve `null`, ou **nunca resolve** (C1) · anti-loop libera sem auditar · anti-loop drena o acumulador (tools não vazam) · modo observação grava mas não bloqueia · grava também os turnos liberados pela camada determinística · turno pegajoso não sobe ao juiz.

## `src/core/turn-tracker.test.ts` — 7 casos

Acumula, sem limite, seria vazamento (I1) · isola sessões · zera no `takeTurn` · **ignora chamadas de subagente** (o filtro load-bearing) · cap de 200 tools por sessão · evicção acima de 50 sessões · pegajosidade dura exatamente um turno.

## `src/core/hooks.test.ts` — 2 casos

`onPreToolUse` registra a tool do agente principal · e ignora a disparada de dentro de subagente (`agent_id` presente).

## `web/server/delegation-gate.integration.test.ts` — 6 casos

Fiação real ponta a ponta: hook real → tracker real → gate real → **SQLite real** (`:memory:`), asserção lendo de volta. Só o juiz é stub.

1. Turno leve grava `layer=deterministic`, `verdict=allow`, `heavyCount` correto; juiz nunca chamado.
2. Turno pesado sem delegação com `ok:false`, modo bloqueio → grava `block` e o gate devolve `{decision:'block'}`.
3. **Modo observação** → grava `verdict=block` mas o gate devolve `{}`. É como vai rodar de verdade.
4. Subagente não conta: 10 Reads de subagente + 1 `Agent` do principal fica leve.
5. Pegajosidade ponta a ponta.
6. `toolCounts` é JSON parseável e bate; `chatId` gravado é o passado.

## `web/server/chat-store.test.ts` — 1 caso

Grava e lê de volta uma auditoria, contra SQLite `:memory:`.

## `web/client/components/toolPanelGrouping.test.ts` — 8 casos

`groupConsecutive` (função pura): colapsa runs do mesmo `toolName` preservando ordem · nomes diferentes não colapsam · `guard` e `prefetch` sempre quebram o run e nunca viram run · run de 1 vira single · array vazio · ordem geral preservada.

## `scripts/e2e-portao.ts` — opt-in

`npm run e2e:portao`. Único caminho que exercita o **juiz haiku real**, chamado de dentro de um hook `Stop` que roda dentro de outro `query()`. Cria fixture temporária, usa banco temporário, recusa sem credencial, limpa em `try/finally`.

**Nunca foi executado.** Ver [o-que-melhorar.md](o-que-melhorar.md).

---

## O que NÃO tem teste nenhum

| Módulo | Risco |
|---|---|
| `src/agents/guardian.ts`, `consultor.ts` | O RAG inteiro — retrieval, ancoragem, MCP in-process. Nenhum teste. |
| `src/agents/main-agent.ts`, `runtime.ts`, `subagents.ts` | Montagem de options, elenco de subagentes, preset. Coberto só indiretamente. |
| `src/agents/enhance.ts`, `tester.ts` | Prompt enhancer e runner de teste. |
| `web/server/server.ts`, `session.ts`, `ai-client.ts` | Transporte WebSocket e ciclo de sessão. |
| `src/rag/index.ts`, `db.ts` | Indexação e acesso ao Neon. |
| `tui/` | A TUI inteira. |
