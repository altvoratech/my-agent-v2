# O que deu certo

O que a suíte de fato prova, e por que se pode confiar nela. Cada item aqui foi verificado por revisão adversarial — a pergunta feita a cada revisor não foi "o teste passa?", e sim **"este teste falharia com a implementação errada?"**.

## 1. A camada de segurança está coberta de verdade

`guard.test.ts` é o único teste do projeto que protege contra dano irreversível, e é o mais completo: 20 casos cobrindo bloqueio de `.env`, fronteira do cwd (incluindo path traversal `../`, `/etc/passwd`, caminhos absolutos fora do projeto), e a política de aprovação por tipo de tool.

Dois pontos finos que o teste trava:

- **`AskUserQuestion` nunca é pré-aprovada.** Há um caso dedicado provando que ela retorna `ask` mesmo com `askOnMutate=false`. Se alguém a colocasse em `allowedTools` "para reduzir atrito", o gate de perguntas ao usuário morreria em silêncio.
- **`Read` não é mutante.** Prova que a política distingue leitura de escrita, em vez de pedir aprovação para tudo.

O guard **não foi tocado** por nenhum commit do portão de delegação — verificado no diff pela revisão final de branch.

## 2. O portão fecha o contrato ponta a ponta

Seis casos de integração exercitam a fiação real: `onPreToolUse` real alimentando o tracker real, o gate real, e `recordDelegationAudit` real escrevendo em SQLite, com a asserção lendo de volta pelo `listDelegationAudits`. Só o juiz é stub.

O caso mais importante é o **modo observação**: prova que uma decisão `block` é *gravada* enquanto o gate devolve `{}` e não interfere no turno. É exatamente como vai rodar nos primeiros dias, e é a diferença entre medir e atrapalhar.

## 3. Fail-open é testado em todos os caminhos

A restrição global mais importante do portão — nenhum caminho pode travar, atrasar ou derrubar um turno — tem quatro casos:

| Caminho | Comportamento provado |
|---|---|
| Juiz lança exceção | libera |
| Juiz devolve `null` | libera |
| Juiz devolve lixo (sem JSON, JSON quebrado, `ok` não-booleano) | `parseVerdict` → `null` → libera |
| **Juiz nunca resolve** | libera dentro do prazo, com fake timers |

O último (C1) só existe porque a revisão final o cobrou: o timeout estava nomeado no spec e não tinha sido implementado nem testado. Hoje há `AbortController` de 8 s no `query()`, `Promise.race` no gate cobrindo qualquer `judgeFn` injetada, e `timeout: 10` no matcher do `Stop` como segunda rede.

## 4. Dois testes provam ordem, não só resultado

São os dois casos que a revisão exigiu depois de constatar que a suíte passaria com a implementação invertida:

- **`anti-loop drena o acumulador`** — falharia se `takeTurn` viesse *depois* do check de `stop_hook_active`, porque as tools vazariam para o turno seguinte e o juiz seria chamado indevidamente. Assertar o retorno não bastava; foi preciso assertar o efeito colateral no turno seguinte.
- **`turno pegajoso não sobe ao juiz`** — falharia se `&& !stickyDelegation` fosse removido de `ambiguous`.

## 5. O filtro de subagente é testado nos três níveis

Chamadas com `agent_id` (isto é, feitas *dentro* de um subagente) não contam como trabalho do agente principal. Sem esse filtro, delegar ao `explorer` — que lê muitos arquivos por natureza — faria o portão disparar contra a própria delegação que ele existe para incentivar.

Coberto em `hooks.test.ts` (o hook filtra), `turn-tracker.test.ts` (o acumulador ignora) e no teste de integração (10 Reads de subagente + 1 `Agent` do principal fica leve).

## 6. A suíte é rápida o bastante para rodar sempre

**134 casos em ~360 ms.** Nenhuma chamada de modelo, nenhum acesso de rede, SQLite em memória. É rápida porque a lógica decisória foi extraída para funções puras (`classifyTurn`, `parseVerdict`, `groupConsecutive`, `chunkMarkdown`) e porque as dependências caras entram por injeção (`judgeFn`, `onAudit`).

Isso não é detalhe de performance: uma suíte de 20 segundos deixa de ser rodada, e uma que não é rodada não protege nada.

## 7. O chunker documenta o comportamento real, não o desejado

`chunker.test.ts` tem um caso chamado *"prosa pura > MAX_CHUNK fica num único chunk"*. Isso não é o comportamento ideal — é o comportamento **real**, descoberto ao escrever o teste e deliberadamente travado em vez de escondido. Quem mexer no chunker vai ver a limitação em vez de descobri-la em produção.
