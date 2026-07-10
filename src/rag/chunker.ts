const MIN_CHUNK = 200;
const MAX_CHUNK = 2000;

interface Unit {
  text: string;
  isCode: boolean;
}

function splitUnits(block: string): Unit[] {
  const lines = block.split('\n');
  const units: Unit[] = [];
  let i = 0;
  const isFence = (l: string) => l.trimStart().startsWith('```');

  while (i < lines.length) {
    if (isFence(lines[i])) {
      const code = [lines[i++]];
      while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
      if (i < lines.length) code.push(lines[i++]); // fence de fechamento
      units.push({ text: code.join('\n'), isCode: true });
    } else {
      const prose = [];
      while (i < lines.length && !isFence(lines[i])) prose.push(lines[i++]);
      const t = prose.join('\n');
      if (t.trim()) units.push({ text: t, isCode: false });
    }
  }
  return units;
}

// Chunking section-aware + fence-aware: quebra nos headings; dentro de seções
// grandes, agrupa por unidades sem cortar code blocks e SEM orfanizar código —
// um code block sempre fica colado à prosa que o precede (não inicia chunk sozinho).
export function chunkMarkdown(text: string): string[] {
  const blocks = text.split(/\n(?=#{1,6}\s)/);
  const chunks: string[] = [];

  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    if (block.length <= MAX_CHUNK) {
      chunks.push(block.trim());
      continue;
    }
    // seção grande: agrupa unidades respeitando MAX, colando código à prosa anterior
    let buf = '';
    for (const unit of splitUnits(block)) {
      const candidate = buf ? `${buf}\n\n${unit.text}` : unit.text;
      // só fecha o buffer ANTES de prosa; antes de código, cola pra não orfanizar.
      if (buf && candidate.length > MAX_CHUNK && !unit.isCode) {
        chunks.push(buf.trim());
        buf = unit.text;
      } else {
        buf = candidate;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  // descarta fragmentos minúsculos de prosa, mas mantém qualquer chunk com código.
  return chunks.filter((c) => c.length >= MIN_CHUNK || c.includes('```'));
}

export { MIN_CHUNK, MAX_CHUNK };
