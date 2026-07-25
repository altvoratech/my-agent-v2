# Testes — my-agent-v2

Registro do que é testado, do que já falhou de verdade, e do que falta.
Última atualização: **2026-07-25**.

## Panorama

| | |
|---|---|
| Runner | Vitest 4 (`environment: node`) |
| Comando | `npm test` · `npm run test:watch` |
| Arquivos | 8 |
| Casos | **134**, todos passando |
| Cobertura por chamada de modelo | **zero** — nenhum teste da suíte padrão chama LLM |
| Verificação com modelo real | `npm run e2e:portao` (opt-in, gasta token, **nunca executado**) |

## Documentos

| Documento | O que responde |
|---|---|
| [inventario.md](inventario.md) | O que existe hoje, arquivo por arquivo, caso por caso |
| [o-que-deu-certo.md](o-que-deu-certo.md) | O que a suíte de fato prova — e por que se pode confiar nela |
| [o-que-falhou.md](o-que-falhou.md) | Falhas reais encontradas: bugs, testes que passavam errado, e o que só apareceu em produção |
| [o-que-melhorar.md](o-que-melhorar.md) | Lacunas, decisões pendentes e próximos passos, priorizados |

## Princípios em vigor

**Nenhum teste da suíte padrão chama modelo.** Determinismo e velocidade acima de fidelidade: a suíte roda em ~360 ms. O que exige modelo real vive num script opt-in, fora do `npm test`.

**Lógica testável é extraída para função pura.** `classifyTurn`, `parseVerdict`, `chunkMarkdown`, `groupConsecutive` — todas puras, todas testadas sem mock. Quando algo é difícil de testar, o sinal é que a fronteira está no lugar errado.

**Dependência entra por injeção, não por import.** O portão recebe `judgeFn` e `onAudit` como parâmetros. Isso é o que permite testar a orquestração inteira sem banco e sem modelo — e é também o que mantém `src/core/` livre de `web/`.

**Teste que passaria com a implementação errada não é teste.** Dois casos assim foram encontrados e corrigidos nesta sessão — ver [o-que-falhou.md](o-que-falhou.md).
