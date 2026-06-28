import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Lê um arquivo de prompt em src/prompts/<name>.md e substitui {{chave}} pelos vars.
 * Separa conteúdo do código: prompts editáveis sem tocar em TypeScript.
 * No runtime multi-provider: quem chama decide se usa o texto como append ao preset
 * claude_code (Claude via claude-agent-sdk) ou como rawPrompt (outros providers).
 */
export function loadPrompt(name: string, vars?: Record<string, string>): string {
  let content = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8')
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      content = content.replaceAll(`{{${key}}}`, value)
    }
  }
  return content
}
