import { describe, it, expect } from 'vitest';
import { chunkMarkdown, MIN_CHUNK, MAX_CHUNK } from './chunker.ts';

// ─── Casos degenerados ─────────────────────────────────────────────────────────

describe('chunkMarkdown — casos degenerados', () => {
  it('string vazia retorna []', () => {
    expect(chunkMarkdown('')).toEqual([]);
  });

  it('só whitespace retorna []', () => {
    expect(chunkMarkdown('   \n\n   ')).toEqual([]);
  });

  it('texto < MIN_CHUNK sem código é descartado', () => {
    expect(chunkMarkdown('# Título\nTexto curto.')).toEqual([]);
  });

  it('texto com exatamente MIN_CHUNK chars é mantido', () => {
    const text = 'a'.repeat(MIN_CHUNK);
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(1);
  });

  it('chunk com código (```) é mantido mesmo < MIN_CHUNK', () => {
    const text = '```js\nconsole.log("x");\n```';
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain('```');
  });
});

// ─── Section-aware (headings) ──────────────────────────────────────────────────

describe('chunkMarkdown — section-aware', () => {
  it('quebra em heading # h1', () => {
    const text = '# A\n' + 'a'.repeat(210) + '\n# B\n' + 'b'.repeat(210);
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(2);
  });

  it('quebra em ## h2', () => {
    const text = '## Intro\n' + 'x'.repeat(210) + '\n## Fim\n' + 'y'.repeat(210);
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(2);
  });

  it('quebra em headings de nível 1-6', () => {
    const levels = ['#', '##', '###', '####', '#####', '######'];
    const text = levels.map((h, i) => `${h} S${i}\n` + `${i}`.repeat(210)).join('\n');
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(6);
  });

  it('cada chunk começa com seu heading', () => {
    const text = '# A\n' + 'a'.repeat(210) + '\n# B\n' + 'b'.repeat(210);
    const chunks = chunkMarkdown(text);
    expect(chunks[0]).toMatch(/^# A/);
    expect(chunks[1]).toMatch(/^# B/);
  });

  it('heading sem espaço após # não quebra (não é heading Markdown)', () => {
    // "#texto" sem espaço: não é heading Markdown válido → não deve quebrar
    const text = '#texto\n' + 'a'.repeat(210) + '\n#outro\n' + 'b'.repeat(210);
    const chunks = chunkMarkdown(text);
    // tudo fica num único bloco porque não há heading real
    expect(chunks.length).toBe(1);
  });

  it('conteúdo antes do primeiro heading é preservado', () => {
    const intro = 'Introdução sem heading. ' + 'x'.repeat(200);
    const text = intro + '\n# Seção\n' + 'y'.repeat(210);
    const chunks = chunkMarkdown(text);
    expect(chunks[0]).toContain('Introdução sem heading');
  });
});

// ─── Fence-aware (code blocks) ────────────────────────────────────────────────

describe('chunkMarkdown — fence-aware', () => {
  it('code block inteiro fica num único chunk', () => {
    const code = '```python\n' + 'x = 1\n'.repeat(20) + '```';
    const text = '# Seção\n' + 'a'.repeat(210) + '\n' + code;
    const chunks = chunkMarkdown(text);
    const codeChunk = chunks.find((c) => c.includes('```python'));
    expect(codeChunk).toBeDefined();
    // o código não foi dividido: abre e fecha fence estão no mesmo chunk
    const fences = (codeChunk!.match(/```/g) ?? []).length;
    expect(fences).toBeGreaterThanOrEqual(2); // abertura + fechamento
  });

  it('código é colado à prosa anterior (não orfanizado)', () => {
    // prosa (300 chars) + code block: juntos passam MAX_CHUNK?
    // NÃO importa — código nunca deflagra flush do buffer
    const prose = 'Explicação: ' + 'a'.repeat(300);
    const code = '```js\nconsole.log("x");\n```';
    const text = '# S\n' + prose + '\n' + code;
    const chunks = chunkMarkdown(text);
    const codeChunk = chunks.find((c) => c.includes('```js'));
    expect(codeChunk).toBeDefined();
    // o chunk com código também contém a prosa que o precede
    expect(codeChunk).toContain('Explicação:');
  });

  it('código grande (> MAX_CHUNK) não é dividido — fica inteiro', () => {
    const bigCode = '```py\n' + 'linha = 1\n'.repeat(250) + '```'; // ~2750 chars
    const text = '# Grande\n' + bigCode;
    const chunks = chunkMarkdown(text);
    const codeChunk = chunks.find((c) => c.includes('```py'));
    expect(codeChunk).toBeDefined();
    expect(codeChunk).toContain('linha = 1'); // conteúdo não foi truncado
    // o chunk pode exceder MAX_CHUNK (por design: código nunca é cortado)
    expect(codeChunk!.length).toBeGreaterThan(MAX_CHUNK);
  });

  it('fence não fechada não explode (código defensivo)', () => {
    const text = '# S\n' + '```py\nx = 1\n' + 'y = 2\n'.repeat(50);
    expect(() => chunkMarkdown(text)).not.toThrow();
  });

  it('múltiplos code blocks numa seção ficam em ordem', () => {
    const block1 = '```js\nfoo();\n```';
    const block2 = '```ts\nbar();\n```';
    const text = '# S\n' + 'prosa '.repeat(50) + '\n' + block1 + '\n' + 'mais prosa '.repeat(40) + '\n' + block2;
    const chunks = chunkMarkdown(text);
    const joined = chunks.join('\n---\n');
    const idx1 = joined.indexOf('foo()');
    const idx2 = joined.indexOf('bar()');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx1).toBeLessThan(idx2); // ordem preservada
  });
});

// ─── Limites MAX_CHUNK ─────────────────────────────────────────────────────────

describe('chunkMarkdown — limites de tamanho', () => {
  // COMPORTAMENTO REAL: splitUnits trata prosa contígua como UMA unidade,
  // independente de parágrafos internos. MAX_CHUNK só subdivide quando há
  // code blocks intercalados criando múltiplas unidades.
  it('prosa pura > MAX_CHUNK fica num único chunk (splitUnits não divide prosa)', () => {
    const para = 'p'.repeat(800);
    const text = '# Grande\n' + [para, para, para].join('\n\n'); // ~2413 chars
    const chunks = chunkMarkdown(text);
    // Toda a prosa vira UMA unidade → um único chunk (por design: código > prosa)
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBeGreaterThan(MAX_CHUNK);
  });

  it('seção com prosa + código gera múltiplos chunks quando prosa excede MAX_CHUNK', () => {
    // prosa (1500 chars) + código: prose_unit depois do código pode disparar flush
    const prose1 = 'a'.repeat(1100); // unidade 1
    const code = '```js\nconsole.log("x");\n```';
    const prose2 = 'b'.repeat(1100); // unidade 2 — dispara flush do buf
    const text = '# S\n' + prose1 + '\n' + code + '\n' + prose2;
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('bloco <= MAX_CHUNK nunca é subdividido', () => {
    const content = 'x '.repeat(900); // ~1800 chars < 2000
    const text = '# H\n' + content;
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBe(1);
  });

  it('chunk com código pode exceder MAX_CHUNK — código nunca é cortado', () => {
    // 'code line\n' = 10 chars × 200 = 2000, + fences = 2009 → bloco total > 2000
    const bigCode = '```py\n' + 'code line\n'.repeat(200) + '```';
    const text = '# S\n' + bigCode; // 4 + 2009 = 2013 > MAX_CHUNK → entra splitUnits
    const chunks = chunkMarkdown(text);
    expect(chunks[0].length).toBeGreaterThan(MAX_CHUNK);
    expect(chunks[0]).toContain('```py');
  });
});

// ─── Integridade do conteúdo ──────────────────────────────────────────────────

describe('chunkMarkdown — integridade', () => {
  it('resultado é determinístico (mesma entrada → mesmo output)', () => {
    const text = '# A\n' + 'x'.repeat(300) + '\n# B\n' + 'y'.repeat(300);
    expect(chunkMarkdown(text)).toEqual(chunkMarkdown(text));
  });

  it('sentinelas únicas aparecem em algum chunk', () => {
    const s1 = 'SENTINEL_ALPHA_UNIQUE';
    const s2 = 'SENTINEL_BETA_UNIQUE';
    const text = `# Intro\n${'x'.repeat(300)} ${s1}\n# Fim\n${'y'.repeat(300)} ${s2}`;
    const chunks = chunkMarkdown(text);
    const joined = chunks.join(' ');
    expect(joined).toContain(s1);
    expect(joined).toContain(s2);
  });

  it('chunks retornados não são strings vazias', () => {
    const text = '# S1\n' + 'a'.repeat(300) + '\n# S2\n' + 'b'.repeat(300);
    const chunks = chunkMarkdown(text);
    for (const c of chunks) {
      expect(c.trim().length).toBeGreaterThan(0);
    }
  });

  it('chunks são trimmados (sem espaços/newlines nas bordas)', () => {
    const text = '\n\n# Seção\n\n' + 'texto '.repeat(50) + '\n\n';
    const chunks = chunkMarkdown(text);
    for (const c of chunks) {
      expect(c).toBe(c.trim());
    }
  });
});

// ─── Casos reais (fixtures) ───────────────────────────────────────────────────

describe('chunkMarkdown — fixtures', () => {
  const FIXTURE = `# Introdução

Este documento descreve como usar a API. ${'Texto de exemplo '.repeat(10)}

## Instalação

Para instalar, execute o seguinte comando:

\`\`\`bash
npm install minha-lib
\`\`\`

${'Detalhes da instalação. '.repeat(15)}

## Configuração

${'Configure assim. '.repeat(20)}

### Variáveis de ambiente

\`\`\`env
API_KEY=xxxx
SECRET=yyyy
\`\`\`

${'Mais detalhes de config. '.repeat(15)}
`;

  it('fixture realista: produz chunks válidos', () => {
    const chunks = chunkMarkdown(FIXTURE);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('fixture: nenhum chunk excede MAX_CHUNK (salvo código intencionalmente grande)', () => {
    const chunks = chunkMarkdown(FIXTURE);
    for (const c of chunks) {
      if (!c.includes('```')) {
        expect(c.length).toBeLessThanOrEqual(MAX_CHUNK + 5);
      }
    }
  });

  it('fixture: code blocks (bash, env) aparecem nos chunks', () => {
    const chunks = chunkMarkdown(FIXTURE);
    const joined = chunks.join('\n');
    expect(joined).toContain('npm install minha-lib');
    expect(joined).toContain('API_KEY=xxxx');
  });
});
