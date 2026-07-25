# O que melhorar

Priorizado por consequência, não por esforço. Nada aqui bloqueia o merge da branch `feat/portao-delegacao`, mas os itens de **decisão pendente** bloqueiam o *uso sério* do portão — sem eles os dados coletados podem não servir para a pergunta que motivou a fase.

---

## Bloco 1 — Decisões pendentes do dono

Quatro pontos em que a implementação diverge do spec ou do plano. Não são bugs: são escolhas que só o dono faz. Levantados pela revisão final de branch.

### 1.1 `HEAVY_TOOLS` inclui `Bash`/`Edit`/`Write`

Pelos números do próprio spec, esses três somam **137 das 265** chamadas medidas. Um turno normal de implementação (6 `Bash` + 2 `Edit`) é classificado como ambíguo e sobe ao juiz — que é então perguntado se o agente deveria ter delegado *edições* ao `explorer`, um subagente **read-only**.

O prompt do juiz mitiga ("em qualquer dúvida, `ok:true`"), mas o token já foi gasto e a latência já foi somada. A afirmação do spec de que "a camada 1 resolve a maioria dos turnos com custo zero" não se sustenta com esse conjunto.

**Opções:** contar só `Read`/`Grep`/`Glob` (é o que foi medido e o que o `explorer` sabe fazer), ou manter os três num peso separado que sozinho não dispara o juiz.
**Custo de mudar:** uma linha — mas a lista está nas Restrições Globais do plano, com valores exatos.

### 1.2 Modo observação paga o juiz

O spec dizia que `DELEGATION_GATE=off` desligaria a **camada 2**. A implementação só suprime o bloqueio: no default, o juiz roda normalmente, custando haiku e latência em todo turno ambíguo. **Não existe nenhum valor da variável que desligue o portão inteiro.**

O plano justificava: precisa de ~20 turnos julgados para calibrar o limiar. Defensável — mas então o spec está desatualizado e o README omite que o modo "observação" custa modelo.

**Sugestão:** três estados — `off` (nem juiz), `observe` (juiz sem bloquear, default), `on` (bloqueia).

### 1.3 O juiz decide sem saber o que foi pedido

O spec especificava `judge(userPrompt, tools)`. A implementação é `judge(tools)`. O juiz vê `Read x8` e nada mais — *"leia estes 8 arquivos e me diga X"* e *"descubra onde mora Y"* são indistinguíveis para ele.

É a maior fonte de falso positivo do desenho, e o dado está de graça: `StopHookInput.last_assistant_message` já está disponível e não é usado.

Enquanto o modo é observação isso não atrapalha o uso — **atrapalha a qualidade dos dados com que a decisão de ligar o bloqueio vai ser tomada**.

### 1.4 `followedUp` é coluna morta

Existe no schema, não está no `INSERT`, não é lida em lugar nenhum. O turno que responderia a pergunta — aquele em que o agente reage ao bloqueio — retorna cedo pelo caminho anti-loop, sem gravar nada. E a lacuna está cristalizada num teste que asserta `onAudit` **não** foi chamado.

**Opções:** gravar o turno anti-loop e fazer um `UPDATE` na última linha `block` do mesmo chat; ou remover a coluna e declarar que é fase 2. O que não pode é ficar prometendo um dado que a implementação não produz.

---

## Bloco 2 — Executar o que já existe

### 2.1 Rodar o e2e pela primeira vez

```bash
npm run e2e:portao
```

Gasta token real (haiku). É o único caminho que exercita o juiz de verdade e a **reentrância** — `query()` chamado de dentro de um hook `Stop` de outro `query()`. Nunca aconteceu.

É o teste de maior valor por execução que existe no projeto agora, e o de maior risco de surpresa.

### 2.2 Calibrar o limiar com dado

Depois de alguns dias em observação:

```sql
SELECT layer, verdict, COUNT(*), ROUND(SUM(judgeCostUsd),4)
FROM delegation_audits GROUP BY layer, verdict;
```

Perguntas que passam a ter resposta: em que fração dos ambíguos o juiz diz `ok:false`? Se for quase zero, `HEAVY_THRESHOLD = 6` está baixo demais; se for quase tudo, alto demais. Quanto custou o juiz no período?

O `6` é herdado do `auditor de referência externo` e **nunca foi medido em lugar nenhum**.

---

## Bloco 3 — Dívida conhecida

### 3.1 `countOf` não é canônico *(corrigir antes de acumular dados)*

`[Read, Grep]` gera `{"Read":1,"Grep":1}` e `[Grep, Read]` gera `{"Grep":1,"Read":1}`. Mesma carga, duas strings — qualquer `GROUP BY toolCounts` futuro fragmenta.

Uma linha (`Object.keys(x).sort()`), e é melhor fazer **antes** que os dados sujos acumulem, já que o propósito da tabela é ser agrupada.

### 3.2 Falha silenciosa por chave estrangeira

Um `chatId` inexistente faz o `INSERT` lançar, o fail-open engole, e a auditoria some sem log. Adicionar um `log.warn` no caminho de erro do `onAudit` tornaria visível.

### 3.3 Vazamento parcial de fixture no e2e

Em `scripts/e2e-portao.ts`, `dbPath` e `fixtureDir` são construídos **antes** do bloco `try`. Se a criação da fixture falhar no meio (disco cheio, permissão), o diretório temporário parcial vaza porque o `finally` nunca roda. Baixa probabilidade; correção é mover a criação para dentro do `try`.

### 3.4 Minors deferidos

| Item | Por que não urge |
|---|---|
| Falta teste isolando `stickyDelegation` entre duas sessões | A isolação é estrutural (`Set` por `sessionId`), não emergente |
| Regex de `parseVerdict` é guloso — dois JSONs degradam para `null` | Fail-open; custa um julgamento perdido, nunca um turno travado |
| Ciclo de import `delegation-gate` ↔ `turn-tracker` | Ambos os usos são lazy; sem TDZ em qualquer ordem de carga |
| `countOf` duplica o reduce de `judge()` | 4 linhas, sem risco de divergência semântica |
| Alias `const heavy = raw.heavy` | Cosmético |
| `--env-file-if-exists` destoa dos outros scripts | Proposital: o e2e é opcional e não deve falhar por falta de `.env` |

---

## Bloco 4 — Cobertura ausente

Ordenado por risco, não por facilidade.

| Módulo | Por que importa |
|---|---|
| **`src/agents/guardian.ts` + `consultor.ts`** | O RAG inteiro sem um único teste — e já sabemos que ele nunca é chamado em produção. Antes de testar, decidir se o guardião fica como está. |
| **`web/server/session.ts` + `ai-client.ts`** | Ciclo de sessão e transporte WS. É onde o `chatId` se perdeu e ninguém viu. |
| `src/agents/main-agent.ts` + `runtime.ts` | Montagem das options: se o `Stop` ou o `allowedTools` mudar por acidente, nada acusa. |
| `src/rag/index.ts` + `db.ts` | Indexação e Neon. Difícil de testar sem banco; talvez só integração. |
| `src/agents/enhance.ts`, `tester.ts` | Prompt enhancer e runner. |
| `tui/` | A TUI inteira. Custo alto, risco baixo — falha visível na hora. |

---

## Sugestão de ordem

1. Rodar o e2e (2.1) — pode mudar tudo o que vem depois.
2. Decidir os quatro pontos do Bloco 1 — sem isso, os dados coletados podem não responder à pergunta.
3. Corrigir `countOf` (3.1) antes de acumular dados.
4. Deixar o portão em observação alguns dias e calibrar (2.2).
5. Só então: cobertura do `session.ts`/`ai-client.ts` (Bloco 4).
