import { createSignal, createEffect, onCleanup, For, Show } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable, InputRenderable } from "@opentui/core"
import { createWsClient } from "../createWsClient"
import type { UIMessage, Todo } from "../createWsClient"
import { COLOR, syntaxStyle, THEMES, setTheme, themeName } from "../theme"
import { DialogSelect, type SelectOption } from "../components/DialogSelect"
import { MODELS, EFFORTS, modelLabel, effortLabel } from "../data"
import { getConfig, updateConfig } from "../config"

type DialogKind = null | "model" | "effort" | "theme" | "commands"

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Ciel",
  thinking: "Thinking",
  tool: "Tool",
  tester: "Tester",
  system: "System",
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function MessageItem(props: { msg: UIMessage; spinner: string; showThinking: boolean }) {
  // Lê COLOR direto (store reativo): trocar o tema recolore os labels/bordas ao vivo.
  // As chaves da Palette batem com os roles (user/assistant/thinking/tool/tester/system).
  const color = () => COLOR[props.msg.role as keyof typeof COLOR] ?? COLOR.text
  // agentName (ex: "Ciel") tem prioridade sobre ROLE_LABEL — permite multi-provider no futuro
  const label = () => props.msg.agentName ?? ROLE_LABEL[props.msg.role] ?? props.msg.role
  // Markdown (com highlight) só pro agente; demais papéis em texto plano.
  const isMarkdown = () => props.msg.role === "assistant" || props.msg.role === "tester"
  const isThinking = () => props.msg.role === "thinking"
  const isUser = () => props.msg.role === "user"

  // Thinking colapsa quando TERMINA (some o conteúdo, fica só um resumo de 1 linha),
  // a menos que showThinking (Ctrl+R). Enquanto streama, mostra ao vivo o raciocínio.
  const collapsed = () => isThinking() && !props.msg.streaming && !props.showThinking
  // Duração formatada: >=1s → "1.2s", <1s → "776ms"
  const durationStr = () => {
    const d = props.msg.duration
    if (d == null) return null
    return d >= 1000 ? `${(d / 1000).toFixed(1)}s` : `${d}ms`
  }
  const summary = () => {
    const first = props.msg.content.split("\n").find((l) => l.trim())?.trim() ?? "raciocínio"
    return first.length > 64 ? first.slice(0, 63) + "…" : first
  }

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={1}
      border={["left"]}
      borderColor={color()}
      backgroundColor={isUser() ? COLOR.element : undefined}
      opacity={isThinking() ? COLOR.thinkingOpacity : 1}
    >
      {/* Label em badge (chip): fundo = cor do papel, texto = cor do fundo do app */}
      <box flexDirection="row">
        <box backgroundColor={color()} paddingX={1}>
          <text fg={COLOR.bg}>
            <b>{label()}</b>
          </text>
        </box>
        <Show when={props.msg.streaming}>
          <text fg={color()}> {props.spinner}</text>
        </Show>
        <Show when={collapsed()}>
          <text fg={COLOR.dim}>
            {" ▸ "}
            {durationStr() ? `Thought · ${durationStr()}` : summary()}
          </text>
        </Show>
      </box>

      {/* Conteúdo — oculto quando o thinking está colapsado */}
      <Show when={!collapsed()}>
        <Show
          when={isMarkdown() && props.msg.content}
          fallback={
            <text paddingLeft={1} wrapMode="word" fg={COLOR.text}>
              {props.msg.content || (props.msg.streaming ? "…" : "")}
            </text>
          }
        >
          <box paddingLeft={1}>
            <markdown
              content={props.msg.content}
              syntaxStyle={syntaxStyle()}
              streaming={props.msg.streaming}
              conceal={true}
            />
          </box>
        </Show>
      </Show>
    </box>
  )
}

// Painel de tarefas: renderiza o plano multi-step do agente (tool nativa TodoWrite)
// ao vivo, encostado acima do input. Concluídas esmaecem; a em andamento destaca.
const TASKS_MAX = 6
function TaskPanel(props: { todos: Todo[] }) {
  const done = () => props.todos.filter((t) => t.status === "completed").length
  const icon = (s: Todo["status"]) => (s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐")
  const color = (s: Todo["status"]) =>
    s === "completed" ? COLOR.assistant : s === "in_progress" ? COLOR.user : COLOR.muted
  const text = (t: Todo) => (t.status === "in_progress" && t.activeForm ? t.activeForm : t.content)
  return (
    <box flexDirection="column" paddingX={1} border={["top"]} borderColor={COLOR.border} backgroundColor={COLOR.surface}>
      <text fg={COLOR.dim}>
        <b>Tarefas</b> · {done()}/{props.todos.length}
      </text>
      <For each={props.todos.slice(0, TASKS_MAX)}>
        {(t) => (
          <text fg={color(t.status)} opacity={t.status === "completed" ? 0.6 : 1} wrapMode="word">
            {icon(t.status)} {text(t)}
          </text>
        )}
      </For>
      <Show when={props.todos.length > TASKS_MAX}>
        <text fg={COLOR.dim}>  … +{props.todos.length - TASKS_MAX}</text>
      </Show>
    </box>
  )
}

// ── Sidebar de contexto ────────────────────────────────────────────────────────
// Aparece à direita quando largura > 110. Mostra tokens usados, % do context
// window e custo acumulado da sessão. Barra de progresso muda de cor perto do limite.
const SIDEBAR_W = 30
// Fonte: docs Anthropic "Context windows" (jul/2026) — Opus 4.6+ e Sonnet 4.6
// são 1M por padrão; Haiku 4.5 é 200k. Default conservador p/ modelo desconhecido.
const MODEL_CTX: Record<string, number> = {
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
}

function ContextSidebar(props: {
  lastResult: { cost?: number; inputTokens?: number; outputTokens?: number } | null
  model: string
}) {
  const maxCtx = () => MODEL_CTX[props.model] ?? 200_000
  const inp = () => props.lastResult?.inputTokens ?? 0
  const out = () => props.lastResult?.outputTokens ?? 0
  const pct = () => Math.min(100, Math.round((inp() / maxCtx()) * 100))
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  // Barra de 10 chars: ■ = usado, ░ = livre
  const bar = () => {
    const filled = Math.round(pct() / 10)
    return `[${"■".repeat(filled)}${"░".repeat(10 - filled)}] ${pct()}%`
  }
  const barColor = () =>
    pct() > 80 ? COLOR.system : pct() > 60 ? COLOR.tool : COLOR.dim

  const hasCost = () => !!props.lastResult?.cost
  const hasTokens = () => inp() > 0

  return (
    <box
      width={SIDEBAR_W}
      flexDirection="column"
      border={["left"]}
      borderColor={COLOR.border}
      paddingX={1}
    >
      <text fg={COLOR.dim}>
        <b>⊙ Contexto</b>
      </text>
      <box height={1} />
      <Show
        when={hasTokens()}
        fallback={<text fg={COLOR.muted}>sem dados ainda</text>}
      >
        <text fg={COLOR.text}>↓ {fmt(inp())} tokens</text>
        <text fg={COLOR.dim}>↑ {fmt(out())} output</text>
        <box height={1} />
        <text fg={barColor()}>{bar()}</text>
      </Show>
      <Show when={hasCost()}>
        <box height={1} />
        <text fg={COLOR.muted}>${props.lastResult!.cost!.toFixed(4)}</text>
      </Show>
    </box>
  )
}

// Verbo de ação por tool — o header diz O QUE será feito, não só "aprovar".
const APPROVAL_VERB: Record<string, string> = {
  Bash: "Executar comando",
  Write: "Escrever arquivo",
  Edit: "Editar arquivo",
  MultiEdit: "Editar arquivo",
  Read: "Ler arquivo",
  Glob: "Buscar arquivos",
  Grep: "Buscar no código",
  WebFetch: "Buscar URL",
}
const APPROVAL_MAX = 8 // linhas de preview de conteúdo antes de truncar
const DIFF_MAX = 5 // linhas por lado do diff (− / +) antes de truncar

function ApprovalCard(props: {
  approval: { id: string; tool: string; input: any }
  onRespond: (id: string, approved: boolean) => void
  onAlways: (id: string, tool: string) => void
}) {
  const dims = useTerminalDimensions()

  useKeyboard((k) => {
    if (k.name === "y" || k.name === "return") props.onRespond(props.approval.id, true)
    else if (k.name === "n" || k.name === "escape") props.onRespond(props.approval.id, false)
    else if (k.name === "a") props.onAlways(props.approval.id, props.approval.tool)
  })

  const tool = () => props.approval.tool
  const input = () => props.approval.input ?? {}
  const verb = () => APPROVAL_VERB[tool()] ?? `Usar ${tool()}`

  const isFile = () => tool() === "Write" || tool() === "Edit" || tool() === "MultiEdit"
  const isEdit = () => tool() === "Edit" || tool() === "MultiEdit"
  const isKnown = () => isFile() || tool() === "Bash"

  // trunca uma linha à largura interna do card (estilo editor, sem wrap)
  const trunc = (s: string) => {
    const max = Math.max(16, dims().width - 6)
    return s.length > max ? s.slice(0, max - 1) + "…" : s
  }
  const linesOf = (v: unknown) => String(v ?? "").split("\n")
  const editOld = () => linesOf(input().old_string)
  const editNew = () => linesOf(input().new_string)
  const writeLines = () => linesOf(input().content)

  // tools desconhecidas: args como "chave: valor"
  const argLines = () =>
    Object.entries(input()).map(
      ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
    )

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={COLOR.accent}
      backgroundColor={COLOR.surface}
      paddingX={1}
      marginX={1}
      gap={0}
    >
      {/* Cabeçalho: verbo de ação + nome da tool à direita */}
      <box flexDirection="row" gap={1}>
        <text fg={COLOR.accent}>
          <b>⚠ {verb()}</b>
        </text>
        <box flexGrow={1} />
        <text fg={COLOR.dim}>{tool()}</text>
      </box>

      {/* Bash: o comando inteiro, com quebra de linha (vê tudo) */}
      <Show when={tool() === "Bash"}>
        <box marginTop={1}>
          <text fg={COLOR.text} wrapMode="word">
            {String(input().command ?? "")}
          </text>
        </box>
      </Show>

      {/* Write/Edit: caminho do arquivo em destaque */}
      <Show when={isFile()}>
        <box marginTop={1}>
          <text fg={COLOR.user}>{trunc(String(input().file_path ?? ""))}</text>
        </box>
      </Show>

      {/* Edit: mini-diff (− removido / + adicionado) */}
      <Show when={isEdit()}>
        <box flexDirection="column">
          <For each={editOld().slice(0, DIFF_MAX)}>
            {(ln) => (
              <text fg={COLOR.system} wrapMode="none">
                {trunc("- " + ln)}
              </text>
            )}
          </For>
          <Show when={editOld().length > DIFF_MAX}>
            <text fg={COLOR.muted}>  … +{editOld().length - DIFF_MAX}</text>
          </Show>
          <For each={editNew().slice(0, DIFF_MAX)}>
            {(ln) => (
              <text fg={COLOR.assistant} wrapMode="none">
                {trunc("+ " + ln)}
              </text>
            )}
          </For>
          <Show when={editNew().length > DIFF_MAX}>
            <text fg={COLOR.muted}>  … +{editNew().length - DIFF_MAX}</text>
          </Show>
        </box>
      </Show>

      {/* Write: preview do conteúdo a ser gravado */}
      <Show when={tool() === "Write"}>
        <box flexDirection="column">
          <For each={writeLines().slice(0, APPROVAL_MAX)}>
            {(ln) => (
              <text fg={COLOR.dim} wrapMode="none">
                {trunc("  " + ln)}
              </text>
            )}
          </For>
          <Show when={writeLines().length > APPROVAL_MAX}>
            <text fg={COLOR.muted}>  … +{writeLines().length - APPROVAL_MAX} linhas</text>
          </Show>
        </box>
      </Show>

      {/* Tools desconhecidas: args como chave: valor */}
      <Show when={!isKnown()}>
        <box flexDirection="column" marginTop={1}>
          <For each={argLines().slice(0, APPROVAL_MAX)}>
            {(ln) => (
              <text fg={COLOR.dim} wrapMode="none">
                {trunc(ln)}
              </text>
            )}
          </For>
        </box>
      </Show>

      {/* Ações */}
      <box flexDirection="row" gap={2} marginTop={1}>
        <text fg={COLOR.assistant}>
          <b>Y</b> aprovar
        </text>
        <text fg={COLOR.system}>
          <b>N</b> recusar
        </text>
        <text fg={COLOR.tool}>
          <b>A</b> sempre
        </text>
        <box flexGrow={1} />
        <text fg={COLOR.dim}>↵ sim · esc não</text>
      </box>
    </box>
  )
}

function AskCard(props: {
  question: {
    id: string
    questions: Array<{ question: string; header: string; options?: Array<{ label: string }> }>
  }
  onRespond: (id: string, answers: Record<string, string>) => void
}) {
  const q = () => props.question.questions[0]
  const [inputVal, setInputVal] = createSignal("")
  const [optIdx, setOptIdx] = createSignal(0)
  const hasOptions = () => (q()?.options?.length ?? 0) > 0

  const submit = (value: string) => {
    if (!value.trim()) return
    props.onRespond(props.question.id, { [q().question]: value })
  }

  useKeyboard((k) => {
    if (hasOptions()) {
      if (k.name === "up") setOptIdx((i) => Math.max(0, i - 1))
      if (k.name === "down")
        setOptIdx((i) => Math.min((q().options?.length ?? 1) - 1, i + 1))
      if (k.name === "return") submit(q().options?.[optIdx()]?.label ?? "")
    }
  })

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={COLOR.accent}
      backgroundColor={COLOR.surface}
      paddingX={1}
      marginX={1}
      gap={0}
    >
      <text fg={COLOR.accent}>
        <b>? {q()?.question}</b>
      </text>
      <Show
        when={hasOptions()}
        fallback={
          <box flexDirection="row" gap={1}>
            <text fg={COLOR.muted}>›</text>
            <input
              onInput={(v: string) => setInputVal(v)}
              onSubmit={(v: string) => submit(v)}
              focused={true}
              placeholder="resposta..."
            />
          </box>
        }
      >
        <For each={q()?.options ?? []}>
          {(opt, i) => (
            <text fg={i() === optIdx() ? COLOR.accent : COLOR.text}>
              <Show when={i() === optIdx()} fallback={`  ${opt.label}`}>
                <b>▸ {opt.label}</b>
              </Show>
            </text>
          )}
        </For>
        <text fg={COLOR.dim} marginTop={1}>↑↓ navegar · Enter selecionar</text>
      </Show>
    </box>
  )
}

function Toast(props: { toast: { text: string; variant: "info" | "success" | "error" } }) {
  const color = () =>
    props.toast.variant === "error"
      ? COLOR.system
      : props.toast.variant === "success"
      ? COLOR.assistant
      : COLOR.user
  return (
    <box
      position="absolute"
      top={2}
      right={2}
      zIndex={4000}
      borderStyle="rounded"
      borderColor={color()}
      backgroundColor={COLOR.surface}
      paddingX={1}
    >
      <text fg={color()}>{props.toast.text}</text>
    </box>
  )
}

export function ChatScreen(props: { chatId: string; cwd: string; onBack: () => void }) {
  const dims = useTerminalDimensions()
  const renderer = useRenderer()
  const {
    store,
    sendMessage,
    stopAgent,
    sendCommand,
    respondApproval,
    respondApprovalAlways,
    respondQuestion,
    showToast,
  } = createWsClient(props.chatId)

  let scroll: ScrollBoxRenderable
  let input: InputRenderable | undefined
  const [inputFocused, setInputFocused] = createSignal(true)

  // Modelo/effort do chat (enviados em cada mensagem; backend recria a sessão ao trocar).
  // Inicializa do config salvo, validando contra MODELS/EFFORTS (ignora valor obsoleto).
  const cfg = getConfig()
  const [model, setModel] = createSignal(
    MODELS.some((m) => m.value === cfg.model) ? cfg.model! : "claude-sonnet-4-6",
  )
  const [effort, setEffort] = createSignal(
    EFFORTS.some((e) => e.value === cfg.effort) ? cfg.effort! : "",
  )

  // Dialog ativo (model/effort/theme/commands) — null = nenhum.
  const [dialog, setDialog] = createSignal<DialogKind>(null)
  // tema ativo antes de abrir o dialog de temas (para reverter no cancelar)
  let themeBefore = themeName()
  const openTheme = () => {
    themeBefore = themeName()
    setDialog("theme")
  }

  // Spinner: cicla enquanto o agente trabalha (streaming/thinking).
  const [spinFrame, setSpinFrame] = createSignal(0)
  const timer = setInterval(() => setSpinFrame((f) => (f + 1) % SPINNER.length), 90)
  onCleanup(() => clearInterval(timer))
  const spinner = () => SPINNER[spinFrame()]

  // Mostrar/ocultar o raciocínio (thinking) já concluído — toggle global (Ctrl+R).
  // Enquanto o agente pensa, o bloco aparece ao vivo; ao terminar, colapsa num resumo.
  const [showThinking, setShowThinking] = createSignal(false)

  // Histórico de mensagens enviadas, navegável com ↑/↓ quando o input está vazio.
  let sent: string[] = []
  let histIdx = -1

  // Foco imperativo no input. No OpenTUI o foco é imperativo: mudar só o prop
  // `focused` não desfoca — sem blur() o input nativo continua capturando teclas
  // (era por isso que o "y" de aprovar vazava e ficava no input). Então damos
  // blur() ao bloquear (approval/question/dialog) e refocamos ao liberar.
  createEffect(() => {
    const blocked = store.pendingApproval || store.pendingQuestion || dialog()
    setInputFocused(!blocked)
    if (blocked) input?.blur()
    else if (input && !input.focused) input.focus()
  })

  const recall = (dir: -1 | 1) => {
    if (!input || !sent.length) return
    if (histIdx === -1 && input.value.trim()) return
    if (histIdx === -1) histIdx = sent.length
    histIdx = Math.max(0, Math.min(sent.length, histIdx + dir))
    input.value = histIdx >= sent.length ? "" : sent[histIdx]
  }

  // Registry de comandos do palette (Ctrl+P).
  const commands: SelectOption[] = [
    { value: "model", label: "Trocar modelo", hint: "Ctrl+M" },
    { value: "effort", label: "Trocar effort", hint: "Ctrl+E" },
    { value: "theme", label: "Trocar tema", hint: "Ctrl+T" },
    { value: "compact", label: "Compactar contexto", hint: "/compact" },
    { value: "test", label: "Rodar tester", hint: "/test" },
    { value: "thinking", label: "Mostrar/ocultar raciocínio", hint: "Ctrl+R" },
    { value: "back", label: "Voltar à lista de chats", hint: "ESC" },
    { value: "exit", label: "Sair do my-agent", hint: "/exit" },
  ]

  // Encerra o app. PRIMEIRO desliga o mouse-tracking de forma síncrona e explícita:
  // `renderer.useMouse = false` chama lib.disableMouse() na hora, mandando as
  // sequências ANSI de disable. É o que conserta o "35;43;15M..." vazando no shell —
  // porque o destroy() ADIA a finalização quando há frame em curso (60fps), e no
  // caminho adiado o OpenTUI NÃO chama disableMouse (só zera o flag interno).
  // Desligar antes garante o mouse off independente do timing do teardown.
  // Depois destroy() restaura o resto (alternate screen, cursor); no FIM do
  // teardown o hook onDestroy (index.tsx) chama process.exit, matando o processo
  // (WebSocket + setInterval do spinner manteriam o event loop vivo).
  const quit = () => {
    renderer.useMouse = false
    renderer.destroy()
  }

  const runCommand = (value: string) => {
    setDialog(null)
    switch (value) {
      case "model":
        setDialog("model")
        break
      case "effort":
        setDialog("effort")
        break
      case "theme":
        openTheme()
        break
      case "compact":
        sendCommand("compact")
        showToast("Compactando contexto...", "info")
        break
      case "test":
        sendCommand("test", undefined, undefined)
        showToast("Rodando tester...", "info")
        break
      case "thinking":
        setShowThinking((v) => !v)
        showToast(showThinking() ? "Raciocínio visível" : "Raciocínio oculto", "info")
        break
      case "back":
        props.onBack()
        break
      case "exit":
        quit()
        break
    }
  }

  // ── Slash autocomplete: digitar "/" abre um popup de comandos sobre o input ──
  const SLASH: SelectOption[] = [
    { value: "model", label: "/model", hint: "trocar modelo" },
    { value: "effort", label: "/effort", hint: "trocar effort" },
    { value: "theme", label: "/theme", hint: "trocar tema" },
    { value: "compact", label: "/compact", hint: "compactar contexto" },
    { value: "test", label: "/test", hint: "rodar tester" },
    { value: "thinking", label: "/thinking", hint: "mostrar/ocultar raciocínio" },
    { value: "back", label: "/back", hint: "voltar à lista" },
    { value: "exit", label: "/exit", hint: "encerrar e fechar" },
  ]
  // Largura fixa da coluna de labels p/ alinhar os hints (não pula ao filtrar).
  const SLASH_LABEL_W = Math.max(...SLASH.map((c) => c.label.length)) + 1
  const [inputText, setInputText] = createSignal("")
  const [slashIdx, setSlashIdx] = createSignal(0)
  const slashMode = () => inputText().startsWith("/")
  const slashItems = (): SelectOption[] => {
    const q = inputText().slice(1).toLowerCase()
    return SLASH.filter((c) => c.value.toLowerCase().startsWith(q))
  }
  const slashOpen = () => slashMode() && slashItems().length > 0 && !dialog()

  // executa o slash selecionado (ou o exato digitado) e limpa o input
  const runSlash = () => {
    const items = slashItems()
    const pick = items[slashIdx()] ?? items[0]
    if (!pick) return false
    if (input) input.value = ""
    setInputText("")
    setSlashIdx(0)
    runCommand(pick.value)
    return true
  }

  useKeyboard((k) => {
    // Card pendente (aprovação/pergunta) ou dialog: eles são donos do teclado.
    // Sem isso, ESC/Ctrl+M/etc vazariam e derrubariam a aprovação em andamento.
    if (dialog() || store.pendingApproval || store.pendingQuestion) return

    if (k.ctrl && k.name === "c") {
      if (store.status !== "idle") stopAgent()
      else quit()
      return
    }
    if (k.name === "escape") {
      // Slash aberto: ESC fecha o menu (limpa o input) em vez de voltar à lista.
      if (slashOpen()) {
        if (input) input.value = ""
        setInputText("")
        setSlashIdx(0)
        return
      }
      props.onBack()
      return
    }
    // Atalhos de dialog
    if (k.ctrl && k.name === "m") return setDialog("model")
    if (k.ctrl && k.name === "e") return setDialog("effort")
    if (k.ctrl && k.name === "t") return openTheme()
    if (k.ctrl && k.name === "p") return setDialog("commands")
    if (k.ctrl && k.name === "r") return setShowThinking((v) => !v)
    // Slash autocomplete aberto: ↑↓ navegam o popup, Tab completa o nome.
    if (slashOpen()) {
      if (k.name === "up") return setSlashIdx((i) => Math.max(0, i - 1))
      if (k.name === "down")
        return setSlashIdx((i) => Math.min(slashItems().length - 1, i + 1))
      if (k.name === "tab") {
        const pick = slashItems()[slashIdx()]
        if (pick && input) {
          input.value = pick.label
          setInputText(pick.label)
        }
        return
      }
      // Enter cai no onSubmit do input (runSlash); demais teclas seguem a digitação.
    }
    // Scrollback da conversa
    if (k.name === "pageup") scroll?.scrollBy(-Math.floor(scroll.height / 2))
    if (k.name === "pagedown") scroll?.scrollBy(Math.floor(scroll.height / 2))
    // Histórico de input (só quando o input tem foco e sem slash)
    if (input?.focused && !slashMode()) {
      if (k.name === "up") recall(-1)
      if (k.name === "down") recall(1)
    }
  })

  const submit = (v: string) => {
    // "/comando" → executa em vez de enviar como mensagem
    if (v.trim().startsWith("/")) {
      if (runSlash()) return
    }
    const text = v.trim()
    if (!text || store.status !== "idle") return
    sendMessage(text, { model: model(), effort: effort(), cwd: props.cwd })
    sent.push(text)
    histIdx = -1
    if (input) input.value = ""
  }

  // Opções dos dialogs (com ● no item atual)
  const modelOpts = (): SelectOption[] =>
    MODELS.map((m) => ({ ...m, current: m.value === model() }))
  const effortOpts = (): SelectOption[] =>
    EFFORTS.map((e) => ({ ...e, current: e.value === effort() }))
  const themeOpts = (): SelectOption[] =>
    Object.keys(THEMES).map((name) => ({ value: name, label: name, current: name === themeName() }))

  const statusColor = () =>
    store.status === "streaming" ? COLOR.accent : store.status === "thinking" ? COLOR.tool : COLOR.muted

  const statusLabel = () =>
    store.status === "streaming"
      ? `${spinner()} streaming`
      : store.status === "thinking"
      ? `${spinner()} thinking`
      : "idle"

  // basename do cwd (cross-platform), com ~ pro home — onde o agente opera
  const cwdLabel = () => {
    const home = process.env.HOME || process.env.USERPROFILE || ""
    if (home && props.cwd === home) return "~"
    const base = props.cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop()
    return base ? `📁 ${base}` : props.cwd
  }

  const costLabel = () =>
    store.lastResult?.cost ? `$${store.lastResult.cost.toFixed(4)}` : ""
  const tokensLabel = () => {
    const r = store.lastResult
    if (!r?.inputTokens && !r?.outputTokens) return ""
    const fmt = (n?: number) => (n && n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0))
    return `↓${fmt(r?.inputTokens)} ↑${fmt(r?.outputTokens)}`
  }

  return (
    <box flexDirection="column" width={dims().width} height={dims().height}>
      {/* Header bar — identidade e config da sessão */}
      <box flexDirection="row" gap={2} paddingX={1} border={["bottom"]} borderColor={COLOR.border}>
        <text fg={COLOR.user}>
          <b>my-agent</b>
        </text>
        <text fg={COLOR.dim}>{cwdLabel()}</text>
        <text fg={COLOR.accent}>{modelLabel(model())}</text>
        <Show when={effort()}>
          <text fg={COLOR.tool}>{effortLabel(effort())}</text>
        </Show>
      </box>

      {/* Content row: messages + sidebar de contexto (quando width > 110) */}
      <box flexDirection="row" flexGrow={1}>
        <scrollbox ref={(r: any) => (scroll = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
          <box height={1} />
          <For each={store.messages}>{(msg) => <MessageItem msg={msg} spinner={spinner()} showThinking={showThinking()} />}</For>
          <Show when={store.messages.length === 0}>
            <box paddingLeft={2} paddingTop={1}>
              <text fg={COLOR.dim}>Nenhuma mensagem ainda. Ctrl+P abre o menu de comandos.</text>
            </box>
          </Show>
          <box height={1} />
        </scrollbox>
        <Show when={dims().width > 110}>
          <ContextSidebar lastResult={store.lastResult} model={model()} />
        </Show>
      </box>

      {/* Painel de tarefas (plano TodoWrite do agente) */}
      <Show when={store.todos.length > 0}>
        <TaskPanel todos={store.todos} />
      </Show>

      {/* Approval */}
      <Show when={store.pendingApproval}>
        {(a) => (
          <ApprovalCard approval={a()} onRespond={respondApproval} onAlways={respondApprovalAlways} />
        )}
      </Show>

      {/* AskUserQuestion */}
      <Show when={store.pendingQuestion}>
        {(q) => <AskCard question={q()} onRespond={respondQuestion} />}
      </Show>

      {/* Slash menu (estilo OpenCode: trilha lateral + linha selecionada com fundo,
          encostado no input — sem caixa de popup) */}
      <Show when={slashOpen()}>
        <box flexDirection="column" paddingX={1} border={["left"]} borderColor={COLOR.accent}>
          <box paddingX={1}>
            <text fg={COLOR.dim}>comandos · ↑↓ navega · enter executa · esc fecha</text>
          </box>
          <For each={slashItems()}>
            {(c, i) => (
              <box
                flexDirection="row"
                paddingX={1}
                backgroundColor={
                  i() === slashIdx() ? (c.value === "exit" ? COLOR.system : COLOR.accent) : undefined
                }
              >
                <text
                  fg={
                    i() === slashIdx() ? COLOR.bg : c.value === "exit" ? COLOR.system : COLOR.text
                  }
                >
                  {c.label.padEnd(SLASH_LABEL_W)}
                </text>
                <text fg={i() === slashIdx() ? COLOR.bg : COLOR.dim}>{c.hint}</text>
              </box>
            )}
          </For>
        </box>
      </Show>

      {/* Input bar */}
      <box flexDirection="row" gap={1} paddingX={1} border={["top"]} borderColor={COLOR.border} height={2}>
        <text fg={slashMode() ? COLOR.accent : store.status !== "idle" ? COLOR.accent : COLOR.muted} height={1}>
          {slashMode() ? "/" : ">"}
        </text>
        <input
          ref={(r: InputRenderable) => (input = r)}
          flexGrow={1}
          onInput={(v: string) => {
            setInputText(v)
            setSlashIdx(0)
          }}
          onSubmit={submit}
          focused={inputFocused()}
          placeholder={
            store.status !== "idle"
              ? "aguardando... (Ctrl+C para parar)"
              : "mensagem... · / comandos · Ctrl+P palette"
          }
        />
      </box>

      {/* Footer — métricas ao vivo da sessão */}
      <box flexDirection="row" gap={2} paddingX={1} border={["top"]} borderColor={COLOR.border}>
        <text fg={statusColor()}>
          {store.status !== "idle" ? spinner() : "●"}
        </text>
        <text fg={statusColor()}>
          {store.status === "streaming" ? "streaming" : store.status === "thinking" ? "thinking" : "pronto"}
        </text>
        <box flexGrow={1} />
        <Show when={tokensLabel()}>
          <text fg={COLOR.dim}>{tokensLabel()}</text>
        </Show>
        <Show when={costLabel()}>
          <text fg={COLOR.muted}>{costLabel()}</text>
        </Show>
      </box>

      {/* Toast */}
      <Show when={store.toast}>{(t) => <Toast toast={t()} />}</Show>

      {/* Dialogs */}
      <Show when={dialog() === "model"}>
        <DialogSelect
          title="Trocar modelo"
          options={modelOpts()}
          onSelect={(v) => {
            setModel(v)
            updateConfig({ model: v })
            setDialog(null)
            showToast(`Modelo: ${modelLabel(v)}`, "success")
          }}
          onCancel={() => setDialog(null)}
        />
      </Show>

      <Show when={dialog() === "effort"}>
        <DialogSelect
          title="Trocar effort (raciocínio)"
          options={effortOpts()}
          onSelect={(v) => {
            setEffort(v)
            updateConfig({ effort: v })
            setDialog(null)
            showToast(`Effort: ${effortLabel(v)}`, "success")
          }}
          onCancel={() => setDialog(null)}
        />
      </Show>

      <Show when={dialog() === "theme"}>
        <DialogSelect
          title="Trocar tema"
          options={themeOpts()}
          onMove={(v) => setTheme(v)}
          onSelect={(v) => {
            setTheme(v)
            updateConfig({ theme: v })
            setDialog(null)
            showToast(`Tema: ${v}`, "success")
          }}
          onCancel={() => {
            setTheme(themeBefore) // reverte o preview ao vivo
            setDialog(null)
          }}
        />
      </Show>

      <Show when={dialog() === "commands"}>
        <DialogSelect
          title="Comandos"
          options={commands}
          onSelect={runCommand}
          onCancel={() => setDialog(null)}
        />
      </Show>
    </box>
  )
}
