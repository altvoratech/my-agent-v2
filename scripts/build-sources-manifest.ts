// Gera sources/manifest.json — REGISTRO das fontes de documentação indexadas no
// Neon (pgvector, tabela "documents"). É a única fonte-da-verdade do que o
// guardião (consultar_guardian) cobre. Regenere após cada `npm run index`:
//   tsx --env-file=.env scripts/build-sources-manifest.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '../src/rag/db.ts';

// Categorização heurística por prefixo/nome do arquivo. Aproximada — serve só
// para agrupar o catálogo de forma legível; a verdade é a coluna `source`.
function categorize(source: string): string {
  if (source.startsWith('opentui-')) return 'opentui';
  if (source.startsWith('solidjs-')) return 'solidjs';
  if (source.startsWith('leonardo-')) return 'leonardo';
  const langRefs = new Set([
    'python.md',
    'typescript.md',
    'standard_library_types.md',
    'base_model.md',
    'pydantic_core.md',
    'fields.md',
  ]);
  if (langRefs.has(source)) return 'language-reference';
  return 'claude-agent-sdk';
}

async function main() {
  const rows = (await sql`
    SELECT source, count(*)::int AS chunks
    FROM documents
    GROUP BY source
    ORDER BY source
  `) as { source: string; chunks: number }[];

  const grouped: Record<string, { source: string; chunks: number }[]> = {};
  let totalChunks = 0;
  for (const r of rows) {
    (grouped[categorize(r.source)] ??= []).push({ source: r.source, chunks: r.chunks });
    totalChunks += r.chunks;
  }

  const groups = Object.fromEntries(
    Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, files]) => [
        name,
        { sources: files.length, chunks: files.reduce((s, f) => s + f.chunks, 0), files },
      ]),
  );

  const manifest = {
    description:
      'Registro das fontes de documentação indexadas no Neon (pgvector, tabela "documents"). ' +
      'O guardião (consultar_guardian) responde ANCORADO apenas nestas fontes. ' +
      'Categorias são heurísticas (por prefixo); a verdade é o campo "source". ' +
      'Regenere com: tsx --env-file=.env scripts/build-sources-manifest.ts',
    generatedAt: new Date().toISOString().slice(0, 10),
    embedding: 'jina-embeddings-v5-text-small · 1024d · cosine (pgvector)',
    totals: { groups: Object.keys(groups).length, sources: rows.length, chunks: totalChunks },
    groups,
  };

  const out = join('sources', 'manifest.json');
  await writeFile(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`manifest: ${rows.length} fontes · ${totalChunks} chunks → ${out}`);
}

main();
