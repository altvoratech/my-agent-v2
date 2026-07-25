# Changelog

Todas as mudanças notáveis deste projeto são documentadas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

---

## [Unreleased]

### Adicionado

- **Portão de delegação (fase 1, em modo observação)** — o agente passa a ser auditado no fim de cada turno pelo hook `Stop` do SDK. Uma camada determinística (`classifyTurn`, função pura) resolve a maioria dos turnos sem chamar modelo: delegou (`Agent`/`Task`/`Skill`) ou fez menos de `HEAVY_THRESHOLD = 6` operações pesadas → libera. Só o turno **ambíguo** — leitura pesada *sem* delegação — sobe a um juiz `haiku`, que devolve a lacuna via `{decision:'block', reason}`. Novo módulo `src/core/delegation-gate.ts`. Motivação medida em `logs/app.jsonl`: 150 das 323 chamadas de tool eram leitura inline no contexto do modelo principal, contra 6 delegações ao subagente `explorer` — que já é `haiku` e read-only.
- **Acumulador de turno (`src/core/turn-tracker.ts`)** — o hook `PreToolUse` já existente passa a alimentar um `Map` em memória por sessão, consumido e zerado no `Stop`. Nada de reparsear transcript. Chamadas vindas de *dentro* de um subagente (`agent_id` presente) são ignoradas de propósito: sem esse filtro, delegar ao `explorer` — que lê muitos arquivos — faria o portão disparar contra a própria delegação que ele existe para incentivar. Caps de 200 tools por sessão e 50 sessões rastreadas, com evicção da mais antiga, sem timer novo.
- **Delegação pegajosa** — uma tool de delegação invocada num turno marca o turno *seguinte* como delegado. Corrige um falso positivo observado ao vivo no auditor de referência: uma `Skill` invocada no turno N é *executada* no N+1, e o auditor, que olha só a janela do turno, lia o N+1 como trabalho pesado sem delegação.
- **Tabela `delegation_audits` (SQLite)** — toda decisão é gravada, inclusive as que liberam: `toolCounts`, `heavyCount`, `delegated`, `layer` (`deterministic`/`judge`), `verdict`, `reason` e `judgeCostUsd`. É o que diferencia este porte da referência que o inspirou, que decide e esquece — e é o que permite calibrar `HEAVY_THRESHOLD` com medição em vez de chute.
- **Modo observação como default** — `DELEGATION_GATE=on` liga o bloqueio; sem isso o portão grava e libera. Sai medindo antes de sair mandando.
- **Teste de integração ponta a ponta** (`web/server/delegation-gate.integration.test.ts`) — 6 casos exercitando a fiação real: hook real → tracker real → gate real → SQLite real (`:memory:`), com asserção lendo de volta. Só o juiz é stub. Verificado por teste de mutação: comentar o `recordTool` em `hooks.ts` derruba os 6.
- **Script e2e opt-in** (`npm run e2e:portao`) — único caminho que exercita o juiz `haiku` de verdade, chamado de dentro de um hook `Stop` que roda dentro de outro `query()`. Cria fixture temporária, usa banco temporário, recusa sem credencial e limpa em `try/finally`. Fora do `npm test` porque gasta token real.
- **`testes/`** — registro organizado da suíte em cinco documentos: panorama, inventário caso a caso (incluindo o que **não** tem teste nenhum), o que a suíte prova de fato, histórico honesto das falhas encontradas, e o que melhorar priorizado.
- **`docs/portao-delegacao.md`** — documentação do portão: o problema medido que o originou (150 leituras inline contra 6 delegações em 323 chamadas), as duas camadas de decisão, o registro em SQLite e o que ficou deliberadamente de fora.
- **Repositório público** — publicado em `altvoratech/my-agent-v2`. O remote privado da Genildocs continua como `origin`; o público entrou como `altvora`.
- **`CONTRIBUTING.md`** — guia de contribuição. Documenta o que não é óbvio de fora: `npm test` roda **offline** (sem Neon, Jina ou chave de API), então mexer em lógica pura, guard, chunker, portão ou UI não exige credencial nenhuma. Registra as invariantes que um PR não pode quebrar — nenhum teste padrão chama modelo, lógica decisória em função pura, dependência cara por injeção, `src/core/` não importa de `web/`, imports com extensão `.ts` sob NodeNext — e o padrão de commit do repositório.
- **Metadados no `package.json`** — `name`, `version`, `description`, `license`, `repository`, `homepage`, `bugs` e `engines`. `"private": true` impede publish acidental no npm agora que existe `name`: o projeto é uma aplicação, não uma lib.
- **`JUDGE_TIMEOUT_MS` e `STOP_HOOK_TIMEOUT_S` configuráveis por variável de ambiente** — para remedir o prazo do juiz sem editar código.
- **TUI: markdown renderizado** — instalada a dependência `web-tree-sitter@0.25.10` (peerDep do `@opentui/core` que não era instalada automaticamente e fazia o tree-sitter falhar silenciosamente). O `<markdown>` no `ChatScreen.tsx` agora roda com `conceal={true}`, ocultando a marcação bruta e exibindo o texto formatado.
- **TUI: estilos `markup.*` no tema** — adicionados ao `syntaxStyle()` em `tui/theme.ts` os tokens `markup.heading` (níveis 1–4), `markup.bold`, `markup.strong`, `markup.italic`, `markup.list`, `markup.quote`, `markup.link` e `markup.raw`. Sem esses tokens o OpenTUI parseava o markdown mas não aplicava ênfase.
- **TUI: syntax highlight de linguagens adicionais** — criado `tui/parsers-config.ts` com 9 linguagens extras (Python, Rust, Go, Bash/sh/shell/zsh/fish, C, C++, JSON, YAML, TOML) via parsers tree-sitter WASM e queries SCM carregados por URL (mesmo padrão do OpenCode). Integrado via `addDefaultParsers(extraParsers)` no `tui/index.tsx`.
- **TUI: tema rico** — `Palette` ganhou 3 níveis de fundo (`bg` / `surface` / `element`) e `thinkingOpacity` nos 4 temas (dark, light, nord, dracula). O `element` é usado no fundo de destaque da mensagem do usuário; `thinkingOpacity` controla o esmaecimento do raciocínio.
- **TUI: borda esquerda colorida por papel** — cada mensagem exibe uma spine `border=["left"]` na cor do papel; mensagem do usuário ganha fundo sutil (`element`) para diferenciar visualmente os turnos.
- **TUI: labels em badge** — `You`, `Agent`, `Thinking` e demais papéis viram chips com fundo na cor do papel e texto invertido, em vez de texto plano, alinhados com o padrão do OpenCode.
- **TUI: thinking colapsável + esmaecido** — bloco de raciocínio renderiza com `opacity` reduzida (via `thinkingOpacity`); ao terminar, colapsa num resumo de 1 linha com `▸`. Atalho `Ctrl+R` e slash `/thinking` para expandir/colapsar os raciocínios concluídos.
- **TUI: TaskPanel (tasklist)** — o `TodoWrite` nativo do SDK agora é capturado em `store.todos` (em vez de vazar no fluxo de mensagens) e renderizado num painel acima do input: contador concluídas/total, ícones `☑ ◐ ☐` coloridos, itens em andamento em destaque, concluídos esmaecidos (`opacity 0.6`), cap de 6 com `… +N`. Paridade com o painel de Tarefas do web chat.
- **TUI: footer de métricas** — tokens (↓↑ formatados em k) e custo do turno movidos da barra superior para uma **barra de rodapé** separada do input; o topo ficou só com identidade (nome · cwd · modelo · effort). Indicador de estado (`● pronto` / spinner animado) com cor por estado (idle/streaming/tool).
- **TUI: menu slash e command palette melhorados** — colunas alinhadas (`padEnd`), header com atalhos, `/exit` adicionado em destaque (cor de perigo) no fim da lista. ESC fecha o menu em vez de navegar pra lista de chats.
- **RAG: base de docs ampliada** — adicionado ao Neon (`documents`): SolidJS framework (overview, api-reference, patterns) via skill `solidjs`. Total: 145 fontes · 1764 chunks em 5 grupos (claude-agent-sdk, opentui, solidjs, leonardo, language-reference).
- **`sources/manifest.json`** — registro declarativo de todas as fontes indexadas no Neon, gerado pelo script `scripts/build-sources-manifest.ts`. É a fonte-da-verdade do que o guardião cobre; regenerado com `npx tsx --env-file=.env scripts/build-sources-manifest.ts` após cada `npm run index`.
- **Prompts do guardião sem enumeração de libs** — removidas as listas de libs hard-coded dos prompts (`consultor.ts`, `guardian.ts`, `main-agent.ts`, `subagents.ts`); regra substituída por "na dúvida, consulte — o guardião diz se não achar nas fontes", com ponteiro para `sources/manifest.json`.

### Corrigido

- **Medidor de janela de contexto subestimava a janela em 5×** — o `CONTEXT_WINDOW` (web, `web/client/components/chat/constants.ts`) e o `MODEL_CTX` (TUI, `tui/screens/ChatScreen.tsx`) chumbavam 200k para todos os modelos, incluindo Opus 4.8 e Sonnet 4.6. Confirmado na doc oficial da Anthropic ("Context windows", jul/2026): Opus 4.6+/4.7/4.8 e Sonnet 4.6 têm **1M por padrão** (sem beta header); só Haiku 4.5 (e Sonnet 4.5) são 200k. A barra dividia `inputTokens` por 200k, então um turno mostrado como 43% de uso era, na real, ~8,6% de 1M — e acenderia âmbar/vermelho (limiares 60%/85%) cinco vezes cedo demais. Corrigido para 1M/1M/200k nos dois lugares.
- **A camada 2 do portão nunca funcionou** — a primeira execução do `npm run e2e:portao` revelou que o juiz era abortado em **toda** chamada real. `JUDGE_TIMEOUT_MS` era 8 s e o matcher do `Stop` 10 s; medido em três rodadas, a mesma chamada `haiku` leva ~2 s isolada e **17–23 s** quando feita de dentro do hook `Stop` de outro `query()` — a reentrância custa de 8 a 11×. Uma rodada em três não respondeu em 90 s. Os prazos passam a 30 s e 35 s. Com eles o portão funcionou ponta a ponta pela primeira vez: veredito `block` com a lacuna escrita, a US$ 0,008–0,013 por julgamento.
- **`toolCounts` não era canônico** — `countOf` serializava as chaves na ordem de chegada, então `[Read, Grep]` e `[Grep, Read]` (a mesma carga de trabalho) geravam strings diferentes e qualquer `GROUP BY toolCounts` fragmentaria em linhas que deviam ser uma só. Passa a ordenar as chaves alfabeticamente. Corrigido **antes** de acumular dados em observação, já que o propósito da tabela é ser agrupada.
- **`npm run e2e:portao` exigia `ANTHROPIC_API_KEY`** e abortava sem ela — mas a aplicação não precisa de API key: sem `settingSources` configurado, o SDK autentica pelo OAuth do Claude Code em `~/.claude/.credentials.json`. O portão de credencial era mais estrito que a própria aplicação e bloqueava a única verificação do juiz real.
- **TUI: shutdown limpo (mouse + processo fantasma)** — o `renderer.destroy()` adia a finalização quando há frame em curso (60fps); o `process.exit(0)` imediato cortava a restauração nativa antes de `lib.disableMouse()`, deixando o mouse-tracking SGR ativo no shell (`35;43;15M...`). Correção: `renderer.useMouse = false` (setter síncrono) antes do `destroy()` em `quit()` e no Ctrl+C; `onDestroy` dispara o `process.exit(0)` somente após a restauração nativa; `exitOnCtrlC: false` para a app assumir o controle do Ctrl+C.
- **TUI: backend órfão no shutdown** — o `killSpawned` era assíncrono (`spawn`); em handler de saída o processo podia encerrar antes do `taskkill /T /F` terminar, deixando o backend na porta 3001. Corrigido para `spawnSync` com guarda anti-duplo-kill, movido para o evento `'exit'` do processo (após a restauração nativa).
- **TUI: Ctrl+C durante streaming não mais encerra o app** — o handler `exitOnCtrlC` interno do OpenTUI e o da app escutavam o mesmo evento; agora só a app controla o Ctrl+C (ocioso → encerra; streaming → para o agente).

---

### Alterado

- **ADR 0001 (motor multi-provider): `Proposto` → `Adiado — aberto a contribuição`.** A análise continua válida e a Opção C continua sendo a recomendação; o que mudou foi a premissa econômica do autor. Fica *adiado* e não *rejeitado* porque duas coisas mudaram: o guard ganhou 63 casos de teste (não existiam quando o ADR foi escrito) e o repositório é público — o custo de implementação deixou de ser necessariamente do autor. Acrescenta as condições para um PR na direção da Opção C.

### Removido

- **`docs/superpowers/` (spec e plano), `docs/multi-provider.md` e `docs/escolha-de-sdk-ia.html`** — os documentos de processo inventariavam ferramentas internas do autor, fora deste repositório e não acionáveis por ninguém de fora; os outros dois eram órfãos não referenciados e superados pela ADR 0001. Removidos também do histórico via `git filter-repo`, antes que o repo público acumulasse clones. A documentação da fase 1 vive agora em `docs/portao-delegacao.md`.

## [0.5.0] — TUI: seletores, temas, configuração persistente e experiência completa no terminal

### Adicionado

- **TUI: configuração persistente (XDG)** — modelo, effort e tema sobrevivem a reinicializações. Salvo em `~/.config/my-agent/config.json` via `tui/config.ts`; lido na inicialização e atualizado em cada troca. Compartilha o mesmo arquivo da config web (chave da API + providers).
- **TUI: paletas de tema centralizadas** — `tui/theme.ts` define quatro temas completos (dark, light, nord, dracula) como `Palette` tipada. O store reativo `COLOR` propaga a troca ao vivo para todo o JSX sem re-render manual. O `syntaxStyle()` é reconstruído apenas quando o tema muda (lazy, com cache por nome).
- **TUI: seletor de tema com preview ao vivo** — `Ctrl+T` abre um `DialogSelect` de temas; mover o cursor no dialog já aplica o tema; cancelar reverte ao estado anterior.
- **TUI: seletores de modelo e effort** — `Ctrl+M` e `Ctrl+E` abrem dialogs fuzzy; a escolha é persistida e enviada no próximo turno.
- **TUI: aprovação de tools repaginada** — card inline com verbo de ação contextual (ex.: "Escrever arquivo", "Executar comando"), mini-diff para edições (linhas − / +), preview de conteúdo para writes. Teclas Y / N / A (sempre) com ownership de teclado: enquanto um card está visível, atalhos globais (ESC, Ctrl+M etc.) não vazam.
- **TUI: AskUserQuestion inline** — card de pergunta direto no fluxo, com suporte a opções (lista navegável ↑↓) ou input livre.
- **TUI: command palette e slash menu** — `Ctrl+P` abre o palette de comandos; digitar `/` no input abre autocomplete estilo OpenCode (encostado no input, com seleção por ↑↓ e Tab).
- **TUI: cwd dinâmico** — o TUI aceita o diretório de trabalho como argumento (`my-agent-tui /caminho`) ou captura o `$PWD` do chamador via launcher global (`bin/my-agent-tui`). O diretório aparece no header e é enviado ao backend a cada mensagem.
- **TUI: bootstrap cross-platform** — `tui/server-bootstrap.ts` sobe e encerra o servidor Express/WebSocket automaticamente; funciona em Windows (PowerShell) e Unix sem bifurcação de código.
- **TUI: footer de sessão** — barra superior com modelo · effort · status (streaming/thinking/idle) com spinner · tokens formatados (k) · custo do turno.
- **TUI: auto-start do backend** — `npm run tui` sobe o servidor se não estiver no ar e o derruba ao sair; se o web já está rodando, o TUI só conecta.

---

## [0.4.0] — Agentes: AskUserQuestion nativa e scripts de RAG

### Adicionado

- **Tool `AskUserQuestion` nativa** — implementada via `canUseTool` no servidor: quando o agente usa essa tool, o servidor roteia a pergunta ao cliente (web ou TUI) em vez de executá-la como tool comum. O cliente responde com as respostas do usuário e o fluxo continua. Suporta múltiplas perguntas e opções predefinidas.
- **Scripts de RAG** — scripts auxiliares para indexação e consulta ao guardião via linha de comando, integrando embedding Jina e vetor store Neon/pgvector.

---

## [0.3.0] — Web chat: base completa

### Adicionado

- **`my-agent-chat`** — cliente web React 18 + Vite + Tailwind sobre servidor Express + WebSocket.
- **Streaming com raciocínio visível** — extended thinking colapsável e persistido no histórico (SQLite).
- **Syntax highlight** — blocos de código com Shiki no cliente web.
- **Diff Git estruturado** — painel por arquivo com badges Adicionado/Modificado/Removido, contagem +/−, modos unificado/dividido e escopos "último turno" / "tudo".
- **Prompt enhancer com aprendizado** — reescreve rascunhos via Haiku one-shot; pares aprovados são guardados no SQLite e reinjetados como few-shot nas próximas melhorias.
- **Sub-agentes** — delegações (`Task`) e consulta ao guardião viram cards inline no fluxo.
- **Guardião ancorado nas docs** — RAG com Jina + Neon/pgvector; ancoragem garantida por código (retrieval antes do `query()`).
- **Segurança em 2 camadas** — guard hook (PreToolUse) veta operações destrutivas; `canUseTool` pede confirmação humana para write/edit/bash, com opção "✓ Sempre".
- **Slash-commands** — `/clear`, `/git`, `/tools`, `/tarefas`, `/compact`, `/guardian`.
- **Ctrl+K** — command palette com busca de arquivos e ações.
- **Sessões SQLite** — renomear/arquivar, retomar contexto, persistência de imagens e exemplos do enhancer.
- **Settings via UI** — modal para configurar `ANTHROPIC_API_KEY` e providers sem reiniciar o servidor; salvo em `~/.config/my-agent/config.json`.
- **Multimodal** — colar imagens no input (valida tipo/tamanho, persiste no SQLite).
