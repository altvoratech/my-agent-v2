// Indexador: lê .md de sources/, divide em chunks, embeda com Jina (passage)
// e grava no Neon. Idempotente (chunk_hash) — re-rodar não duplica nem re-embeda.
//
// Uso: npx tsx --env-file=.env index.ts [pasta]   (default: ./sources)

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { embed } from './jina.ts';
import { insertChunk } from './db.ts';
import { chunkMarkdown } from './chunker.ts';

const EMBED_BATCH = 50; // textos por chamada à Jina

function hashChunk(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function main() {
  const dir = process.argv[2] ?? './sources';
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.error(`Nenhum .md em ${dir}`);
    process.exit(1);
  }
  console.log(`Indexando ${files.length} arquivo(s) de ${dir}\n`);

  let totalChunks = 0;
  let inserted = 0;
  let skipped = 0;

  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8');
    const chunks = chunkMarkdown(raw);
    totalChunks += chunks.length;

    // embeda em lotes
    const records: { content: string; hash: string; index: number }[] = chunks.map((content, index) => ({
      content,
      hash: hashChunk(content),
      index,
    }));

    for (let i = 0; i < records.length; i += EMBED_BATCH) {
      const batch = records.slice(i, i + EMBED_BATCH);
      const vectors = await embed(batch.map((r) => r.content), 'retrieval.passage');
      for (let j = 0; j < batch.length; j++) {
        const ok = await insertChunk({
          source: file,
          chunkIndex: batch[j].index,
          content: batch[j].content,
          chunkHash: batch[j].hash,
          embedding: vectors[j],
        });
        ok ? inserted++ : skipped++;
      }
    }
    console.log(`  ${file}: ${chunks.length} chunks`);
  }

  console.log(`\nTotal: ${totalChunks} chunks | inseridos: ${inserted} | já existentes: ${skipped}`);
}

main();
