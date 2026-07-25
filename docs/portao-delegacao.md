# Portão de delegação

**Status:** fase 1 implementada · default = **observação** (grava, não bloqueia)
**Código:** `src/core/delegation-gate.ts` · `src/core/turn-tracker.ts`
**Registro:** tabela `delegation_audits` em `web/server/chat-store.ts`

Este documento explica **por que** o portão existe e como ele decide. O que a
suíte prova sobre ele está em [`testes/`](../testes/).

---

## O problema, medido

O agente principal deste repositório orquestra subagentes especialistas
(`src/agents/subagents.ts`). Um deles, o `explorer`, é **read-only** (`Read`,
`Glob`, `Grep`) e roda em **haiku**. Ele existe justamente para absorver
investigação de código.

Medição sobre `logs/app.jsonl` — período de 04 a 10 de julho de 2026, **323
chamadas de tool**, todas de sessões do agente principal (os eventos
`tool.pre`/`tool.post` só são emitidos por `src/core/hooks.ts`, usado apenas por
`main-agent.ts` e `tester.ts`):

```
115  Bash        11  Edit         6  Agent
100  Read        11  Write        5  AskUserQuestion
 25  Grep         9  mcp__*
 25  Glob         5  ToolSearch
──────────────────────────────────────────────
150  operações de leitura (Read + Grep + Glob)
  6  delegações via Agent
```

Duas leituras desses números:

1. **150 leituras entraram no contexto do modelo principal.** O conteúdo dos
   arquivos é reenviado a cada turno subsequente da conversa.
2. **As 6 delegações foram investigações grandes e explicitamente enquadradas**
   ("análise estruturada do projeto", "mapear a sidebar"). As outras 150 leituras
   aconteceram inline, uma a uma.

O mecanismo de delegação existe e é subusado. O ganho de delegar **não é preço
por token** — haiku é cerca de 3× mais barato que sonnet, não 25×. O ganho é que
o conteúdo dos arquivos **nunca entra no contexto principal**: só o relatório do
subagente volta.

---

## Como o portão decide

O portão mora no hook **`Stop`** do Agent SDK: audita o turno inteiro depois que
ele fecha, em vez de interromper o trabalho no meio. O `PreToolUse` já é do
guard, e empilhar contagem de leitura lá misturaria duas responsabilidades —
segurança e economia — num ponto que hoje é simples e bem testado.

```
Stop
 │
 ├── camada 1: DETERMINÍSTICA (sem modelo, custo zero)
 │     delegou no turno? ──────────────────────► libera
 │     leituras pesadas < HEAVY_THRESHOLD ─────► libera
 │                                                 │
 └── camada 2: JUIZ (haiku, só no caso ambíguo) ───┘
       recebe a lista real de tool calls do turno
       ok:true  ────────────────────────────────► libera
       ok:false ────────────────────────────────► bloqueia com a lacuna
                                                     │
                                    o motivo volta para o modelo,
                                    que delega e continua
```

Constantes de partida — **hipóteses registradas, não verdades medidas**:

```ts
const DELEGATION_TOOLS = new Set(['Agent', 'Task', 'Skill']);
const HEAVY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit']);
const HEAVY_THRESHOLD = 6;
```

### Delegação pegajosa

Uma tool de delegação invocada no turno N marca o turno **N+1** como delegado.
Isso corrige um falso positivo real: uma `Skill` invocada no turno N só é
*executada* no N+1, e um auditor que olha apenas a janela do turno lê o N+1 como
trabalho pesado sem delegação.

### Chamadas de subagente não contam

Tool calls disparadas de *dentro* de um subagente (`agent_id` presente no input
do hook) são ignoradas pelo acumulador. Sem esse filtro, delegar ao `explorer` —
que lê muitos arquivos por natureza — faria o portão disparar contra a própria
delegação que ele existe para incentivar.

### Fail-open em todos os caminhos

Nenhum caminho do portão pode travar, atrasar ou derrubar um turno. Juiz que
lança, devolve `null`, devolve lixo ou **nunca responde** (há `AbortController`
de 30 s, `Promise.race` no gate e `timeout: 35` no matcher) sempre resulta em
liberar o turno. O caso "nunca responde" não é hipotético — ver
[a reentrância](#a-reentrância-cobra-caro-e-às-vezes-trava).

---

## Registro

Toda decisão é gravada em `delegation_audits`, inclusive as que liberam:
`toolCounts`, `heavyCount`, `delegated`, `layer` (`deterministic` | `judge`),
`verdict`, `reason` e `judgeCostUsd`.

Decidir e esquecer não permitiria calibrar nada. Com o registro, o
`HEAVY_THRESHOLD` deixa de ser chute:

```sql
SELECT layer, verdict, COUNT(*), ROUND(SUM(judgeCostUsd), 4)
FROM delegation_audits GROUP BY layer, verdict;
```

Se o juiz quase nunca disser `ok:false`, o limiar está baixo demais; se disser
quase sempre, alto demais.

---

## Modos

| `DELEGATION_GATE` | Comportamento |
|---|---|
| não definido (**default**) | **observação** — grava a decisão, não bloqueia o turno |
| `on` | bloqueia: um veredito `ok:false` devolve a lacuna ao modelo |

O default é observação de propósito: são necessários dezenas de turnos julgados
para calibrar o limiar antes de o bloqueio valer a pena.

---

## O que ainda não está resolvido

Quatro pontos abertos, documentados em
[`testes/o-que-melhorar.md`](../testes/o-que-melhorar.md) — entre eles o
`HEAVY_TOOLS` incluir `Bash`/`Edit`/`Write` (que sozinhos somam mais da metade
das chamadas medidas) e o juiz decidir sem receber o pedido original do usuário.

### A reentrância cobra caro, e às vezes trava

Medido em 2026-07-25 pelo `npm run e2e:portao`, a única verificação que exercita
o juiz de verdade (os testes da suíte usam `judgeFn` mockado):

| Contexto | Tempo |
|---|---|
| a mesma chamada haiku, isolada | ~2 s |
| de dentro do hook `Stop` de um `query()` vivo | **17–23 s** |
| uma rodada em três | **não respondeu em 90 s** |

Chamar `query()` de dentro de um hook de outro `query()` custa de 8 a 11× — e em
parte das vezes não retorna. Por isso `JUDGE_TIMEOUT_MS` é 30 s (era 8 s, que
abortava sempre) e o matcher do `Stop` tem 35 s. Ambos ajustáveis por variável de
ambiente (`JUDGE_TIMEOUT_MS`, `STOP_HOOK_TIMEOUT_S`) para remedir sem editar
código.

O custo por julgamento ficou entre **US$ 0,008 e US$ 0,013**.

**Consequência em aberto:** num turno que trava, o portão adiciona 30 s de espera
para não produzir nada. Como o modo default é observação — onde o veredito não
altera o turno — o juiz não precisaria bloquear o fechamento. Rodá-lo de forma
assíncrona eliminaria a latência e tornaria o travamento inofensivo.

```bash
npm run e2e:portao   # opt-in, gasta token (~US$ 0,15 por rodada, os dois modelos)
```

### O guardião RAG ficou deliberadamente de fora

No mesmo período medido, `consultar_guardian` foi chamado **zero vezes** — e não
por falta de acesso: a tool está registrada em `mcpServers` e pré-aprovada em
`allowedTools`. A causa é competição: ela disputa com `Read`/`Grep`/`Glob`/`Bash`
(265 das 323 chamadas) e, num agente de código trabalhando dentro do repo, a
verdade está no disco.

O nicho legítimo do guardião é estreito — como uma biblioteca ou API **externa**
deve ser usada segundo a documentação oficial. Forçar a chamada por portão
resolveria o sintoma errado. Fica registrado como achado, fora de escopo.
