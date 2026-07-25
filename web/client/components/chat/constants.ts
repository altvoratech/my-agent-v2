// tempo relativo curto ("há 3 min", "há 2 h", "há 5 d")
export function relTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "agora";
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  return `há ${Math.floor(diff / 86400)} d`;
}

export const EFFORTS = [
  { id: "", label: "Padrão" },
  { id: "low", label: "Baixo" },
  { id: "medium", label: "Médio" },
  { id: "high", label: "Alto" },
  { id: "xhigh", label: "Máximo" },
];

// janela de contexto por modelo (tokens). Fonte: docs Anthropic "Context windows"
// (jul/2026) — Opus 4.6+/4.7/4.8 e Sonnet 4.6 são 1M por padrão (sem beta header);
// Haiku 4.5 e Sonnet 4.5 são 200k. Default conservador 200k p/ modelo desconhecido.
export const CONTEXT_WINDOW: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
};
export function contextWindowFor(model: string) {
  return CONTEXT_WINDOW[model] ?? 200_000;
}

export const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
