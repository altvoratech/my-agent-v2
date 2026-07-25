// Script e2e OPT-IN do portão de delegação — o ÚNICO lugar que exercita o juiz
// haiku de verdade, chamado de dentro de um hook Stop que roda dentro de outro
// query() (reentrância do SDK nunca verificada em execução real; os 128+6
// testes unitários/integração mockam judgeFn de propósito).
//
// Uso: npm run e2e:portao   (carrega .env se existir, via --env-file-if-exists)
//
// GASTA TOKENS REAIS (dois modelos: o agente principal + o juiz haiku).
//
// Restrições (ver relatório da tarefa):
// - NÃO usa data/chat.db — banco temporário em os.tmpdir().
// - NÃO toca o repo real — cwd do agente é um diretório de fixture descartável.
// - Roda em modo OBSERVAÇÃO (enabled:false / DELEGATION_GATE != 'on'): audita,
//   nunca bloqueia o turno.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

console.warn(
  '\n⚠️  scripts/e2e-portao.ts faz chamadas de modelo REAIS (agente principal + juiz ' +
    'haiku) e GASTA TOKENS de verdade. Prosseguindo...\n',
);

async function findCredential(): Promise<{ source: string } | null> {
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return { source: 'env ANTHROPIC_API_KEY' };
  }
  // .env já foi carregado pelo próprio script runner (--env-file-if-exists=.env);
  // se a key estivesse lá, o bloco acima já teria pego. Resta o config.json do TUI/web.
  try {
    // import direto do config-store para reusar a MESMA resolução de credencial
    // que o servidor web usa (env > ~/.config/my-agent/config.json).
    const { resolveApiKey, syncProviderEnv } = await import('../web/server/config-store.ts');
    syncProviderEnv();
    const resolved = resolveApiKey('anthropic');
    if (resolved) return { source: `config (~/.config/my-agent/config.json, via ${resolved.source})` };
  } catch {
    // se o import falhar por qualquer motivo, cai no erro padrão abaixo.
  }
  return null;
}

async function assertCredentialOrExit(): Promise<void> {
  const cred = await findCredential();
  if (cred) {
    console.log(`Credencial encontrada: ${cred.source}.`);
    return;
  }
  console.error(
    '\nERRO: nenhuma credencial Anthropic configurada.\n\n' +
      'Configure UMA das opções antes de rodar `npm run e2e:portao`:\n' +
      '  1. export ANTHROPIC_API_KEY=sk-ant-...\n' +
      '  2. Crie um arquivo .env na raiz do repo com ANTHROPIC_API_KEY=sk-ant-...\n' +
      '  3. Salve a chave em ~/.config/my-agent/config.json (mesmo arquivo usado pelo TUI/web;\n' +
      '     veja web/server/config-store.ts / tui/config.ts).\n',
  );
  process.exit(1);
}

// Fixture: uns 8 arquivos .ts pequenos e plausíveis, para o agente ter o que
// ler sem tocar no repo real. Propositalmente "largo" (vários arquivos
// pequenos e relacionados) para incentivar leitura ampla no prompt abaixo.
const FIXTURE_FILES: Record<string, string> = {
  'src/index.ts': `export * from './user.ts';\nexport * from './order.ts';\nexport * from './pricing.ts';\n`,
  'src/user.ts': `export interface User {\n  id: string;\n  name: string;\n  email: string;\n}\n\nexport function formatUserLabel(u: User): string {\n  return \`\${u.name} <\${u.email}>\`;\n}\n`,
  'src/order.ts': `import type { User } from './user.ts';\n\nexport interface Order {\n  id: string;\n  user: User;\n  items: string[];\n  totalCents: number;\n}\n\nexport function orderSummary(o: Order): string {\n  return \`Pedido \${o.id}: \${o.items.length} itens, total \${o.totalCents}c\`;\n}\n`,
  'src/pricing.ts': `export function applyDiscount(cents: number, pct: number): number {\n  return Math.round(cents * (1 - pct / 100));\n}\n`,
  'src/inventory.ts': `export interface StockItem {\n  sku: string;\n  qty: number;\n}\n\nexport function isLowStock(item: StockItem, threshold = 5): boolean {\n  return item.qty <= threshold;\n}\n`,
  'src/notifications.ts': `export type NotificationChannel = 'email' | 'sms' | 'push';\n\nexport function pickChannel(preferred: NotificationChannel[]): NotificationChannel {\n  return preferred[0] ?? 'email';\n}\n`,
  'src/utils/date.ts': `export function daysBetween(a: Date, b: Date): number {\n  const ms = Math.abs(b.getTime() - a.getTime());\n  return Math.floor(ms / (1000 * 60 * 60 * 24));\n}\n`,
  'src/utils/id.ts': `export function shortId(): string {\n  return Math.random().toString(36).slice(2, 10);\n}\n`,
};

function makeFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-portao-fixture-'));
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

interface Row {
  id: string;
  chatId: string | null;
  createdAt: string;
  toolCounts: string;
  heavyCount: number;
  delegated: 0 | 1;
  layer: 'deterministic' | 'judge';
  verdict: 'allow' | 'block';
  reason: string | null;
  judgeCostUsd: number | null;
}

function printTable(rows: Row[]): void {
  if (rows.length === 0) {
    console.log('(nenhuma linha em delegation_audits)');
    return;
  }
  const cols: (keyof Row)[] = ['layer', 'verdict', 'heavyCount', 'delegated', 'toolCounts', 'reason', 'judgeCostUsd'];
  console.log(cols.join(' | '));
  console.log(cols.map((c) => '-'.repeat(String(c).length)).join('-|-'));
  for (const r of rows) {
    console.log(cols.map((c) => String(r[c] ?? '')).join(' | '));
  }
}

async function main(): Promise<void> {
  await assertCredentialOrExit();

  const dbPath = path.join(tmpdir(), `e2e-portao-${randomUUID()}.db`);
  process.env.CHAT_DB = dbPath;

  const fixtureDir = makeFixtureDir();

  console.log(`Banco temporário: ${dbPath}`);
  console.log(`Fixture (cwd do agente): ${fixtureDir}`);

  try {
    // Importado DEPOIS de fixar CHAT_DB — o módulo abre o banco em tempo de
    // import (mesmo padrão de web/server/chat-store.test.ts e do teste de
    // integração do gate).
    const { chatStore, listDelegationAudits, recordDelegationAudit } = await import('../web/server/chat-store.ts');
    const { buildMainAgentOptions } = await import('../src/agents/main-agent.ts');

    const chat = chatStore.createChat('e2e-portao');

    const prompt =
      'Antes de fazer qualquer mudança, faça um levantamento AMPLO deste projeto: ' +
      'leia TODOS os arquivos .ts dentro de src/ e src/utils/ (são cerca de 8 arquivos ' +
      'pequenos) para entender o domínio (usuário, pedido, preço, estoque, notificação, ' +
      'utilitários de data/id) e como eles se relacionam. NÃO delegue essa leitura a ' +
      'nenhum subagente — leia cada arquivo você mesmo, diretamente. Ao final, escreva ' +
      'um resumo curto (3-5 linhas) do domínio.';

    console.log('\nRodando o agente principal (modo observação: audita, não bloqueia)...\n');

    for await (const message of query({
      prompt,
      options: buildMainAgentOptions({
        model: 'sonnet',
        cwd: fixtureDir,
        // enabled=false (modo observação) — não passamos DELEGATION_GATE=on,
        // então buildMainAgentOptions monta o gate com enabled:false por padrão.
        onApproval: async () => false, // exercício read-only: nega qualquer mutação
        onQuestion: async () => ({}),
        onAudit: (row) =>
          recordDelegationAudit({
            id: randomUUID(),
            chatId: chat.id,
            createdAt: new Date().toISOString(),
            ...row,
          }),
      }),
    })) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content as any[]) {
          if ('text' in block && block.text) process.stdout.write(block.text);
          else if ('name' in block) process.stdout.write(`\n[tool: ${block.name}]\n`);
        }
      } else if (message.type === 'result') {
        console.log(`\n\n[fim do turno — custo total: ${'total_cost_usd' in message ? message.total_cost_usd : '?'} USD]`);
      }
    }

    const rows = listDelegationAudits(chat.id) as Row[];
    console.log('\n--- delegation_audits (banco temporário) ---');
    printTable(rows);

    const judgeRows = rows.filter((r) => r.layer === 'judge');
    for (const r of judgeRows) {
      console.log(`\n[juiz chamado] reason=${r.reason ?? '(nenhum)'} judgeCostUsd=${r.judgeCostUsd ?? '(desconhecido)'}`);
    }

    if (rows.length === 0) {
      console.error('\nFALHA: nenhuma linha foi gravada em delegation_audits — o hook Stop não auditou o turno.');
      process.exitCode = 1;
    } else {
      console.log(`\nOK: ${rows.length} linha(s) gravada(s) em delegation_audits.`);
      process.exitCode = 0;
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

main().catch((err) => {
  console.error('ERRO inesperado no e2e-portao:', err);
  process.exitCode = 1;
});
