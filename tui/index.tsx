import path from "node:path"
import { statSync } from "node:fs"
import { render } from "@opentui/solid"
import { createCliRenderer, addDefaultParsers } from "@opentui/core"
import { extraParsers } from "./parsers-config"
import { App } from "./App"
import { ensureServer } from "./server-bootstrap"
import { setTheme } from "./theme"
import { getConfig } from "./config"

// Registra linguagens extras de syntax highlight (Python, Rust, Go, Bash…)
// carregadas sob demanda pelo tree-sitter worker via URL.
addDefaultParsers(extraParsers)

// Aplica o tema salvo antes do primeiro render (setTheme ignora nome inválido).
const savedTheme = getConfig().theme
if (savedTheme) setTheme(savedTheme)

// Diretório onde o AGENTE vai operar. Vem de argv[2] (o launcher global passa o
// $PWD de onde você chamou) ou do process.cwd(). O backend revalida e recusa
// caminho inexistente, mas checamos aqui pra dar erro claro antes de tomar a tela.
const targetCwd = path.resolve(process.argv[2] || process.cwd())
try {
  if (!statSync(targetCwd).isDirectory()) throw new Error("não é um diretório")
} catch {
  console.error(`\n  ⚠ Diretório inválido: ${targetCwd}\n`)
  process.exit(1)
}

// 1) Garante o backend de pé (sobe sozinho se preciso) ANTES de tomar o terminal.
let cleanup = () => {}
try {
  const r = await ensureServer()
  cleanup = r.cleanup
} catch (e) {
  // ainda não tomamos o terminal: erro vai pro stdout normal.
  console.error(`\n  ⚠ ${(e as Error).message}\n`)
  process.exit(1)
}

// 2) Renderer. Mata o servidor que NÓS subimos ao sair (o já-rodando fica).
const renderer = await createCliRenderer({
  // Ctrl+C é tratado pela app (ChatScreen/ChatListScreen). Desligamos o atalho
  // interno do OpenTUI: ele escuta o MESMO keypress e agendaria um destroy em
  // todo Ctrl+C — inclusive durante o streaming, onde Ctrl+C deve só PARAR o
  // agente, não sair. Com isso a app tem controle total da saída.
  exitOnCtrlC: false,
  targetFps: 60,
  // Desambígua Ctrl+M de Enter, Ctrl+I de Tab, etc. (Kitty suporta nativo; em
  // terminais sem o protocolo, faz fallback pro legado automaticamente).
  useKittyKeyboard: {},
  // Saída DEFINITIVA: roda no FIM do teardown do renderer, depois que a lib
  // nativa já restaurou o terminal (alternate screen, mouse-tracking, cursor).
  // É aqui que matamos o processo — um process.exit ANTES disso cortaria a
  // restauração e deixaria o mouse vazando "35;43;15M..." no shell.
  onDestroy: () => process.exit(0),
})
// O cleanup (taskkill SÍNCRONO do backend) roda no 'exit' do processo — ou seja
// DEPOIS de a lib nativa ter restaurado o terminal. NÃO ligamos no evento "destroy"
// do renderer: ele dispara ANTES de lib.destroyRenderer(), e o spawnSync do taskkill
// bloquearia o event loop bem no meio da restauração do terminal (alternate screen,
// cursor, mouse). Fluxo: destroy → restaura terminal → onDestroy → process.exit → cleanup.
process.on("exit", cleanup)

await render(() => <App cwd={targetCwd} />, renderer)
