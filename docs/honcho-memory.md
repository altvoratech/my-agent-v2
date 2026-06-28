# Memória curada (Honcho) — pendência de implementação

> **Status:** decidido + ancorado, **falta implementar**. A conta no Honcho já foi criada.
> Próximo passo concreto: colar a `HONCHO_API_KEY` no `.env` e construir o `src/memory/honcho-client.ts`.

## A premissa (por que Honcho, e não só o SQLite)

O insight veio da doc do [Honcho](https://honcho.dev) — a mesma distinção que torna o NotebookLM bom: **ancoragem + síntese**, não despejo de transcript.

> **Histórico = o que foi dito.**
> **Memória = conclusões raciocinadas sobre o usuário, além do que foi explicitamente declarado.**

O modelo é de "detetive": quando consultado, o Honcho **não** devolve mensagens brutas — ele **infere** fatos ("o usuário prefere Git Bash", "a direção do projeto é ser provider-agnostic") a partir de padrões em múltiplas sessões. Isso é a **reasoning layer** (Deriver), que processa em background.

## O que já temos vs. o que o Honcho adiciona

| Primitiva Honcho | my-agent hoje | Gap |
|---|---|---|
| **Workspace** | o app (1 instância) | — (string `workspaceId`) |
| **Sessions** | tabela `chat` no SQLite ✅ | espelhar no Honcho |
| **Messages** | tabela `messages` no SQLite ✅ (+ `agentName`) | espelhar no Honcho |
| **Peers** (user/assistant) | `role` em cada mensagem ✅ | mapear p/ `peer(id)` |
| **Conclusions** (insights sintetizados) | ❌ não existe | **é aqui que mora a memória curada** |
| **Reasoning layer** (detetive) | ❌ não existe | gerenciado pelo Honcho (Deriver) |

O SQLite continua sendo a fonte-da-verdade do **histórico** (offline, local, rápido). O Honcho entra como camada de **memória** por cima — os dois coexistem.

## Confirmado pelo guardião (doc Honcho indexada no Neon — 43 chunks, 4 fontes)

**Setup é mínimo — só a API key. Nada se configura no dashboard.** Workspace, peers e sessions são todos **get-or-create automático** via SDK:

| Entidade | Como nasce | Precisa de dashboard? |
|---|---|---|
| Workspace | `honcho.workspace()` / 1ª operação com `workspaceId` → cria se não existir | ❌ |
| Peer | `await honcho.peer("user-123")` → "cria ou recupera" | ❌ |
| Session | `honcho.session(id)` → "cria ou recupera" | ❌ |
| Messages | `session.addMessages([...])` | ❌ |
| **API Key** | gerada em `app.honcho.dev` | ✅ **único passo manual** |

Pontos críticos da API (v2.1.0):
- `honcho.peer(id)` e `honcho.session(id)` **sempre disparam API call** (breaking change v2.1.0 — não são mais lazy). `peer()` exige `await`.
- `workspaceId` é só uma **string de isolamento** (tenant) — usar `my-agent-v2`. Separa ambientes (`-prod` × `-dev`).
- API gerenciada: SDK aponta pra `https://api.honcho.dev` por default. Sem DB/vector store/workers pra configurar.
- **Não coberto na doc indexada:** o que o dashboard exibe além de gerar a key (provável só observabilidade — visualizar o que o SDK criou). Confirmar no painel.

## O que falta implementar

### 1. Config (`.env`)
```bash
HONCHO_API_KEY=<chave do app.honcho.dev>     # ← usuário cola
HONCHO_WORKSPACE_ID=my-agent-v2               # opcional, default no código
```

### 2. Cliente + helpers (`src/memory/honcho-client.ts`, novo)
Singleton do Honcho com degradação graciosa (**se faltar `HONCHO_API_KEY`, vira no-op** — o app funciona normal sem memória):
- `syncSession(sessionId, messages[])` → espelha turnos no Honcho (`session.addMessages`).
- `getContext(sessionId, { tokenBudget })` → `summary` + `peer_card` pra injetar no system prompt do Ciel.
- `saveMemory(peerId, content)` → `peer.conclusions.create({ content })` (memória explícita).
- `searchMemory(peerId, query, topK)` → `peer.conclusions.query(...)` (busca semântica).

### 3. Integração no fluxo do turno (`web/server/session.ts`)
- **Início da sessão:** `getContext()` → injetar `summary`/`peer_card` no system prompt (via append do preset `claude_code`, como já fazemos com `{{cwd}}`).
- **Fim de cada turno:** `syncSession()` com a mensagem do user + a do Ciel → o Deriver processa em background.

### 4. Tools do agente (`MemoryWrite` / `MemoryRead`)
Expor como tools no `query()` (em `allowedTools`) pra o **próprio Ciel** decidir o que gravar/recuperar explicitamente — análogo ao `consultar_guardian`. Ancorar a implementação no guardião antes de codar (forma das tools no Claude Agent SDK).

## Decisões em aberto

1. **`peerId` do usuário:** fixo (`"user"`) ou por máquina/email (`dragonbrothers.ai@gmail.com`)? Fixo basta pra single-user; email prepara multi-device.
2. **Síntese automática vs. explícita:** o Deriver do Honcho já sintetiza sozinho a partir das mensagens. As tools `MemoryWrite`/`MemoryRead` são a camada explícita por cima. Começar só com sync automático + `getContext`, e adicionar as tools depois? (menor superfície inicial).
3. **Onde injetar o contexto:** system prompt do Ciel (`src/prompts/ciel.md` via append) — confirmar token budget pra não estourar.

## Quando retomarmos

1. Usuário cola `HONCHO_API_KEY` no `.env`.
2. Construir `src/memory/honcho-client.ts` (singleton + 4 helpers, no-op sem key).
3. Plugar `syncSession`/`getContext` no `session.ts` (sync no fim do turno, contexto no início).
4. (2ª fase) tools `MemoryWrite`/`MemoryRead` — ancorar no guardião antes.
5. Atualizar `CHANGELOG`/`README` (Roadmap: "Memória curada" → em progresso).

> **Relacionado:** [multi-provider.md](./multi-provider.md) — quando `agentName` deixar de ser sempre "Ciel" (multi-provider), o `peer` do assistant pode refletir o modelo ativo.
