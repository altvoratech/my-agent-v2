import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks hoistados antes de qualquer import do módulo
vi.mock('./logger.ts', () => ({
  log: {
    warn: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  },
  logEvents: { emit: vi.fn() },
  LOG_FILE: 'logs/app.jsonl',
  LOG_FILE_TXT: 'logs/app.log',
  LOG_DIR: 'logs',
}));

vi.mock('./hooks.ts', () => ({
  onPreToolUse: vi.fn().mockResolvedValue({}),
  onPostToolUse: vi.fn().mockResolvedValue({}),
}));

import { createGuardedHooks } from './guard.ts';

const CWD = '/home/user/project';

// Constrói input mínimo compatível com PreToolUseHookInput
function fakeInput(toolName: string, toolInput: Record<string, unknown>) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

// Extrai e executa apenas o hook de guard (índice 1 — depois do onPreToolUse de tracking)
async function runGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts: { askOnMutate?: boolean } = {},
) {
  const { PreToolUse } = createGuardedHooks(CWD, opts);
  const guardHook = PreToolUse[0].hooks[1] as (input: unknown) => Promise<unknown>;
  return guardHook(fakeInput(toolName, toolInput)) as Promise<Record<string, unknown>>;
}

// ─── DANGEROUS_BASH: deve NEGAR ───────────────────────────────────────────────

describe('Bash — comandos perigosos (deny)', () => {
  it.each([
    ['rm -rf /',       'rm -rf /'],
    ['rm -rf .',       'rm -rf .'],
    ['rm -r subdir',   'rm -r subdir'],
    ['rm -f arquivo',  'rm -f /etc/passwd'],
    ['mkfs',           'mkfs.ext4 /dev/sda1'],
    ['dd if=',         'dd if=/dev/sda of=backup.img'],
    ['fork bomb',      ':() { :|:& };:'],
    ['write /dev/sda', 'echo perigo > /dev/sda'],
    ['write /dev/hda', 'cat file > /dev/hda'],
    ['sudo',           'sudo apt-get install vim'],
    ['chmod -R',       'chmod -R 777 /'],
    ['git reset --hard',  'git reset --hard HEAD'],
    ['git reset --hard~', 'git reset --hard~1'],
    ['git clean -fd',  'git clean -fd'],
    ['git clean -df',  'git clean -df'],
    ['git clean -f',   'git clean -f'],
  ])('nega: %s', async (_, cmd) => {
    const result = await runGuard('Bash', { command: cmd });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });
});

// ─── DANGEROUS_BASH: deve PERMITIR ────────────────────────────────────────────

describe('Bash — comandos seguros (allow)', () => {
  it.each([
    ['redirect /dev/null',        'echo foo > /dev/null'],
    ['stderr para /dev/null',     'cmd 2>/dev/null'],
    ['redirect /dev/stdout',      'ls > /dev/stdout'],
    ['redirect /dev/stderr',      'cmd 2>/dev/stderr'],
    ['cat /dev/stdin (leitura)',  'cat /dev/stdin'],
    ['tty',                       'tty -s && cat /dev/tty'],
    ['fd redirect',               'cmd > /dev/fd/1'],
    ['/dev/zero (read)',          'cat /dev/zero | head -c 10'],
    ['/dev/urandom',              'head -c 4 /dev/urandom'],
    ['/dev/random',               'head -c 4 /dev/random'],
    ['npm install',               'npm install'],
    ['ls',                        'ls -la'],
    ['git status',                'git status'],
    ['git reset (sem --hard)',    'git reset HEAD arquivo.ts'],
    ['git clean -n (dry-run)',    'git clean -n'],
    ['npx tsc',                   'npx tsc --noEmit'],
    ['rm sem -r/-f',              'rm arquivo.txt'],
  ])('permite: %s', async (_, cmd) => {
    const result = await runGuard('Bash', { command: cmd });
    expect(result).toEqual({});
  });
});

// ─── Write/Edit: proteção de .env ─────────────────────────────────────────────

describe('Write/Edit — proteção .env', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit'] as const) {
    it(`${tool}: nega .env na raiz do projeto`, async () => {
      const result = await runGuard(tool, { file_path: `${CWD}/.env` });
      expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    });

    it(`${tool}: nega .env relativo`, async () => {
      const result = await runGuard(tool, { file_path: '.env' });
      expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    });

    it(`${tool}: nega .env fora do projeto`, async () => {
      const result = await runGuard(tool, { file_path: '/home/user/.env' });
      expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    });
  }
});

// ─── Write/Edit: boundary do projeto ──────────────────────────────────────────

describe('Write/Edit — boundary do cwd', () => {
  it('permite arquivo dentro do cwd', async () => {
    const result = await runGuard('Write', { file_path: `${CWD}/src/file.ts` });
    expect(result).toEqual({});
  });

  it('permite subpasta dentro do cwd', async () => {
    const result = await runGuard('Write', { file_path: `${CWD}/web/server/session.ts` });
    expect(result).toEqual({});
  });

  it('nega arquivo fora do cwd', async () => {
    const result = await runGuard('Write', { file_path: '/home/user/other-project/file.ts' });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });

  it('nega path traversal (../)', async () => {
    const result = await runGuard('Write', { file_path: `${CWD}/../other/file.ts` });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });

  it('nega /etc/passwd', async () => {
    const result = await runGuard('Write', { file_path: '/etc/passwd' });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });

  it('nega /tmp/fora', async () => {
    const result = await runGuard('Edit', { file_path: '/tmp/malicious.sh' });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });
});

// ─── AskUserQuestion ──────────────────────────────────────────────────────────

describe('AskUserQuestion', () => {
  it('sempre retorna ask (sem aprovar via canUseTool)', async () => {
    const result = await runGuard('AskUserQuestion', { question: 'Continuar?' });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('ask mesmo com askOnMutate=false', async () => {
    const result = await runGuard('AskUserQuestion', { question: 'Ok?' }, { askOnMutate: false });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });
});

// ─── askOnMutate ──────────────────────────────────────────────────────────────

describe('askOnMutate', () => {
  it('sem opção: Write seguro retorna {} (auto-allow)', async () => {
    const result = await runGuard('Write', { file_path: `${CWD}/file.ts` });
    expect(result).toEqual({});
  });

  it('com askOnMutate: Write seguro retorna ask', async () => {
    const result = await runGuard('Write', { file_path: `${CWD}/file.ts` }, { askOnMutate: true });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('com askOnMutate: Edit retorna ask', async () => {
    const result = await runGuard('Edit', { file_path: `${CWD}/file.ts` }, { askOnMutate: true });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('com askOnMutate: MultiEdit retorna ask', async () => {
    const result = await runGuard('MultiEdit', { file_path: `${CWD}/file.ts` }, { askOnMutate: true });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('com askOnMutate: NotebookEdit retorna ask', async () => {
    const result = await runGuard('NotebookEdit', { notebook_path: `${CWD}/nb.ipynb` }, { askOnMutate: true });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('com askOnMutate: Bash seguro retorna ask', async () => {
    const result = await runGuard('Bash', { command: 'npm install' }, { askOnMutate: true });
    expect(result?.hookSpecificOutput).toMatchObject({ permissionDecision: 'ask' });
  });

  it('com askOnMutate: tool read-only (Read) retorna {} — não é mutante', async () => {
    const result = await runGuard('Read', { file_path: `${CWD}/file.ts` }, { askOnMutate: true });
    expect(result).toEqual({});
  });
});

// ─── Tools de leitura (sem restrição) ─────────────────────────────────────────

describe('Tools de leitura', () => {
  it.each(['Read', 'Glob', 'Grep', 'LS'])('%s retorna {}', async (tool) => {
    const result = await runGuard(tool, { path: `${CWD}/src` });
    expect(result).toEqual({});
  });
});

// ─── Estrutura do retorno ──────────────────────────────────────────────────────

describe('Estrutura do hook retornado', () => {
  it('deny inclui hook_event_name e permissionDecisionReason', async () => {
    const result = await runGuard('Bash', { command: 'rm -rf /' });
    const out = result?.hookSpecificOutput as Record<string, unknown>;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(typeof out.permissionDecisionReason).toBe('string');
    expect((out.permissionDecisionReason as string).length).toBeGreaterThan(0);
  });

  it('createGuardedHooks retorna PreToolUse e PostToolUse', () => {
    const hooks = createGuardedHooks(CWD);
    expect(hooks).toHaveProperty('PreToolUse');
    expect(hooks).toHaveProperty('PostToolUse');
    expect(hooks.PreToolUse[0].hooks).toHaveLength(2);
  });
});
