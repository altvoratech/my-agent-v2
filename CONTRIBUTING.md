# Contribuindo com o my-agent-v2

Obrigado pelo interesse. Este documento é curto de propósito: cobre o que você
precisa para rodar, as poucas invariantes que um PR não pode quebrar, e onde a
ajuda vale mais.

---

## Você provavelmente não precisa de credencial nenhuma

Este é o ponto que costuma surpreender. A suíte de testes roda **offline**:

```bash
npm install
npm test        # ~98 casos, ~200 ms, zero chamada de rede
```

Sem Neon, sem Jina, sem chave da Anthropic. Se a tua contribuição é no guard de
segurança, no chunker do RAG, na lógica da UI ou em qualquer função pura, esse é
o ciclo inteiro de desenvolvimento.

Credencial só é necessária para **executar o agente de verdade**:

| O que você quer fazer | O que precisa |
|---|---|
| Rodar a suíte, mexer em lógica pura, UI, tipos | nada |
| Rodar o agente (web ou TUI) | `ANTHROPIC_API_KEY` |
| Mexer no RAG / guardião (indexar e buscar) | `DATABASE_URL` (Neon + `pgvector`) e `JINA_API_KEY` |

O setup completo das credenciais e do banco está no [README](README.md#-setup).

---

## Rodando cada superfície

```bash
npm run web         # web chat: server (3001) + Vite (5173) → http://localhost:5173
npm run tui         # TUI no terminal — requer Bun; sobe o backend sozinho
npm run ask "..."   # CLI: uma pergunta às docs (guardião + RAG)
npm run typecheck   # tsc do servidor (NodeNext) + do cliente (bundler)
```

Node ≥ 20. O TUI — e **só** o TUI — exige [Bun](https://bun.sh), porque depende
do preload do OpenTUI/SolidJS declarado em `bunfig.toml`.

---

## Invariantes

Estas não são preferências de estilo. São decisões estruturais que sustentam o
projeto; um PR que as quebre vai ser pedido de volta.

**1. Nenhum teste da suíte padrão chama modelo.**
Determinismo e velocidade acima de fidelidade — uma suíte de 20 segundos deixa
de ser rodada, e uma que não é rodada não protege nada. O que exige modelo real
vive num script opt-in, fora do `npm test`.

**2. Lógica decisória mora em função pura.**
Quando algo é difícil de testar, o sinal é que a fronteira está no lugar errado.
Extraia a decisão para uma função sem efeito colateral e teste-a direto, sem
mock.

**3. Dependência cara entra por injeção, não por import.**
Banco, modelo e I/O chegam como parâmetro. É o que permite testar a orquestração
inteira sem infraestrutura.

**4. `src/core/` não importa de `web/`.**
O núcleo (guard, hooks, logger) é usado pelo servidor web, pelo TUI e pela CLI.
A dependência aponta numa direção só.

**5. Imports relativos levam a extensão `.ts`.**
O `tsconfig` usa `module: NodeNext`; sem a extensão o import quebra em runtime.

```ts
import { log } from './logger.ts';   // ✅
import { log } from './logger';      // ❌ quebra sob NodeNext
```

**6. Teste que passaria com a implementação errada não é teste.**
Antes de abrir o PR, quebre de propósito o código que você acabou de escrever e
confirme que o teste falha. Se ele continuar verde, ele não está testando o que
você acha que está — isso já aconteceu duas vezes neste repositório.

---

## Segurança

O agente lê, escreve e executa comandos na máquina de quem o roda. Duas camadas
seguram isso: o **guard hook** (`src/core/guard.ts`), que veta o destrutivo
automaticamente, e o **`canUseTool`**, que pede confirmação humana antes de cada
escrita ou comando.

Alterações em `src/core/guard.ts` são revisadas com rigor extra, e nenhuma
liberação entra sem teste que a cubra. Se um PR precisa afrouxar o guard para
funcionar, o desenho provavelmente está errado — abra uma issue antes de
escrever o código.

Nunca commite credencial. `.env`, `data/` e a configuração local já estão no
`.gitignore`.

---

## Abrindo um PR

1. **Abra uma issue antes**, se a mudança for maior que uma correção pontual.
   Evita trabalho jogado fora — algumas direções já foram avaliadas e recusadas,
   e o porquê está em [`docs/adr/`](docs/adr/).
2. Um PR resolve **uma** coisa. Refatoração e correção no mesmo diff dobram o
   custo da revisão.
3. `npm test` e `npm run typecheck` verdes.
4. Commits no padrão do repositório — [Conventional
   Commits](https://www.conventionalcommits.org/) em português:

   ```
   feat(tui): seletor de tema com preview ao vivo
   fix(guard): path traversal escapava com ../ duplo
   docs(readme): documentar a suíte de testes
   test: cobrir o caminho de fail-open do juiz
   ```
5. Na descrição, diga **como verificar** o que você fez. "Roda X, espera Y" vale
   mais que um parágrafo de explicação.

---

## Onde ajudar

O [Roadmap do README](README.md#-roadmap--funcionalidades-futuras) lista as
direções abertas. Duas observações honestas sobre elas:

- **Motor multi-provider** é a maior e a mais valiosa. Existe uma ADR avaliando
  três abordagens em [`docs/adr/0001-motor-multi-provider.md`](docs/adr/0001-motor-multi-provider.md)
  — leia antes de propor, porque duas das opções já foram descartadas e o
  documento explica por quê.
- **Cobertura de teste** é a lacuna mais fácil de atacar e a de retorno mais
  imediato: o RAG (`src/agents/guardian.ts`, `consultor.ts`) e o transporte
  WebSocket (`web/server/session.ts`, `ai-client.ts`) não têm teste nenhum.

Dúvida sobre escopo ou direção? Abra uma issue. Perguntar custa menos que
escrever código que não vai entrar.
