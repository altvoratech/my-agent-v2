# O que falhou

Registro honesto das falhas reais desta sessão. Não é lista de bugs abertos (isso está em [o-que-melhorar.md](o-que-melhorar.md)) — é o histórico do que quebrou, **onde foi pego, e o que isso ensina sobre onde os testes são cegos**.

---

## 1. Testes que passavam com a implementação errada

**Duas vezes.** Os dois casos foram encontrados na revisão da tarefa, não pela suíte.

### `takeTurn` antes ou depois do anti-loop

O gate drena o acumulador de tools *antes* de checar `stop_hook_active`. Se a ordem fosse invertida, as tools do turno bloqueado vazariam para o turno seguinte, e o juiz seria chamado indevidamente com trabalho que não era daquele turno.

**Os 8 testes existentes passavam com a ordem invertida**, porque todos assertavam apenas o valor de retorno. A ordem só se manifesta no *turno seguinte*.

Correção: um caso que roda dois turnos e asserta que o segundo não chama o juiz.

### Pegajosidade removida

Retirar `&& !stickyDelegation` da expressão de `ambiguous` também mantinha a suíte verde. A pegajosidade é justamente a correção de um falso positivo observado em produção (item 3 abaixo) — e não tinha teste no nível do portão.

**Lição:** assertar o retorno de uma função não prova a ordem das operações dentro dela. Onde há efeito colateral entre chamadas, o teste precisa rodar mais de uma vez.

---

## 2. Timeout: exigido pelo spec, nunca implementado, passou por 9 revisões

O spec listava "timeout" nominalmente em duas seções — na política de fail-open e na lista de testes obrigatórios. A implementação cobriu "juiz lança" e "juiz devolve lixo", **e não cobriu "juiz nunca responde"**.

O `try/catch` pega *erro*; não pega *pendurado*. Uma chamada haiku travada (rede, rate limit, provider lento) deixaria o hook `Stop` aguardando e o turno do agente sem fechar.

Passou por 9 tarefas com revisão individual. **Só a revisão da branch inteira pegou** — porque só ela leu o spec de origem lado a lado com o resultado final.

**Lição:** revisão por tarefa verifica o que a tarefa pediu. Ninguém verifica o que o spec pediu e nenhuma tarefa implementou, exceto uma revisão de escopo maior.

---

## 3. Falso positivo do auditor, observado ao vivo

Durante esta própria sessão, um auditor de delegação externo — implementação de referência em Python, fora deste repositório — bloqueou um turno alegando falta de delegação — **depois** de a skill `writing-plans` ter sido invocada e seguida.

Causa: o auditor localiza o último prompt do usuário e olha só as tool calls posteriores. Uma `Skill` invocada no turno N e *executada* no turno N+1 desaparece da janela; o N+1 parece trabalho pesado sem delegação.

`Agent`/`Task` não sofrem disso (abrem e fecham no mesmo turno). `Skill` sofre.

O porte herdaria o defeito — foi o que motivou a delegação pegajosa. Está documentado no spec, §7 item 4.

**Lição:** o defeito só apareceu porque o mecanismo estava rodando de verdade, contra trabalho real. Nenhuma revisão de código o teria encontrado.

---

## 4. Vazamento de memória por um consumidor que ninguém tinha mapeado

`src/agents/tester.ts` monta `createGuardedHooks` — logo, alimenta o acumulador de turnos via `onPreToolUse`. Mas o tester **não tem hook `Stop`**, então nada drena o que ele acumula. Cada execução deixava uma entrada permanente num `Map` de processo longo.

Nenhum teste de unidade poderia pegar isso: cada módulo estava correto isoladamente. O problema era a *combinação* — e só apareceu quando alguém perguntou "quem mais chama isto?".

Corrigido com cap de 200 tools por sessão e evicção acima de 50 sessões, sem timer novo.

---

## 5. Índice que nasceu morto

A tabela `delegation_audits` tem `chatId TEXT REFERENCES chats(id)` e um índice `idx_audits_chat(chatId, createdAt)`. O `AgentSession` gravava **`chatId: null` fixo** — o valor existia um nível acima, em `session.ts`, e simplesmente não era repassado.

Consequência: o índice não servia para nada e a pergunta que justifica a fase inteira — *"este chat delegou mais depois que o portão entrou?"* — ficava sem resposta.

Passou por revisão de tarefa (que verificou o brief, e o brief mandava `chatId: null`) e só caiu na revisão de branch, que leu o spec.

---

## 6. Guardião RAG: 0 chamadas em 323

Não é falha de teste — é **falha de produto**, medida sobre `logs/app.jsonl` (04–10/jul, 323 tool calls de sessões do Ciel).

```
115 Bash · 100 Read · 25 Grep · 25 Glob · 11 Edit · 11 Write · 6 Agent
  0 mcp__consultor__consultar_guardian
```

Zero eventos `guardian.*` também — `askGuardian()` nunca rodou.

Não é falta de acesso: a tool está registrada em `mcpServers` e **pré-aprovada** em `allowedTools`. O modelo simplesmente nunca a escolhe, porque compete com `Read`/`Grep`/`Glob`/`Bash` (265 das 323 chamadas) e, num agente de código dentro do repo, a verdade está no disco.

O RAG inteiro **não tem um único teste**.

---

## 7. Bug encontrado ao escrever os testes de integração

`delegation_audits.chatId` tem `FOREIGN KEY REFERENCES chats(id)`. Se `recordDelegationAudit` for chamado com um `chatId` que não existe na tabela `chats`, o insert lança — e como o gate é fail-open, **o `catch` engole o erro e a auditoria desaparece sem log visível**.

Hoje não deve ocorrer (o `ai-client.ts` sempre usa um chat real), mas é um modo de falha silencioso: o portão continua funcionando e para de registrar, sem ninguém saber.

Registrado, **não corrigido** — a decisão é do dono.

---

## 8. A camada 2 nunca funcionou — e o fail-open escondia

Executado em 2026-07-25. Os 134 testes usam `judgeFn` mockado; o `scripts/e2e-portao.ts` foi rodado pela primeira vez e derrubou duas suposições.

**Primeiro**, o script se recusava a rodar: exigia `ANTHROPIC_API_KEY` e não existe nenhuma na máquina. A aplicação sempre autenticou pelo OAuth da assinatura em `~/.claude/.credentials.json`. O portão de credencial era mais estrito que a própria aplicação.

**Segundo**, com o bloqueio removido, o juiz foi abortado aos 8 s — o valor de `JUDGE_TIMEOUT_MS`. Medição em três rodadas:

| Contexto | Tempo |
|---|---|
| a mesma chamada haiku, isolada | ~2 s |
| de dentro do hook `Stop` de um `query()` vivo | 17–23 s |
| 1 rodada em 3 | não respondeu em 90 s |

A reentrância custa de 8 a 11×, e às vezes trava de vez. **Os 8 s nunca tiveram chance.**

O mais grave é o modo de falha: fail-open funcionou perfeitamente e mascarou tudo. Uma semana em observação teria produzido só linhas `layer=judge, verdict=allow, reason=null` — a conclusão errada de que o agente delega bem, apoiada em dado que parecia bom.

**Lição:** um caminho que só é exercitado em produção e falha *aberto* não gera alarme nenhum. Ele gera dado silenciosamente vazio. Fail-open protege o turno e esconde o defeito — a contrapartida precisa ser medir o caminho real pelo menos uma vez.

Com 30 s, o portão funcionou ponta a ponta pela primeira vez: veredito `block` com a lacuna escrita, a US$ 0,008–0,013 por julgamento.

---

## Onde os testes se provaram

Por contraste, vale registrar o que funcionou como controle: durante a revisão dos testes de integração, o revisor **comentou a chamada `recordTool` dentro de `onPreToolUse`** e reexecutou a suíte. Os 6 testes de integração falharam, e depois o arquivo foi restaurado.

É a única forma de saber que um teste de fiação testa a fiação, e não a si mesmo.
