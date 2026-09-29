import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const MAX_FILES = 8
const MAX_DIAGNOSTICS = 20

export function changedFiles(tool, input) {
  if (tool === 'edit' || tool === 'write') return typeof input?.path === 'string' ? [input.path] : []
  if (tool !== 'patch' || typeof input?.patchText !== 'string') return []
  const paths = []
  for (const line of input.patchText.split(/\r?\n/)) {
    const operation = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
    if (operation) paths.push(operation[1])
  }
  return paths
}

export async function diagnosticFeedback(lsp, root, tool, input, signal) {
  const changed = changedFiles(tool, input)
  // didSave handles existing sources; lock changes and removals reload the graph.
  const relevant = changed.filter(path => path.endsWith('Syrox.lock') ||
    (path.endsWith('.srx') && !existsSync(resolve(root, path))))
  if (relevant.length) lsp.notifyChanges(relevant)
  const paths = [...new Set(changed.filter(path => path.endsWith('.srx')))]
  if (!paths.length) return ''
  const lines = []
  for (const path of paths.slice(0, MAX_FILES)) {
    if (!existsSync(resolve(root, path))) {
      lines.push(`${path}: arquivo removido; grafo Syrox notificado`)
      continue
    }
    try {
      const diagnostics = await lsp.query(path, 'diagnostics', {}, signal)
      if (!diagnostics.length) {
        lines.push(`${path}: sem diagnósticos Syrox`)
        continue
      }
      for (const item of diagnostics.slice(0, MAX_DIAGNOSTICS)) {
        const at = item.range?.start
        const line = (at?.line ?? 0) + 1
        const column = (at?.character ?? 0) + 1
        lines.push(`${path}:${line}:${column}: ${item.severity === 1 ? 'erro' : 'aviso'} [${item.code ?? 'syrox'}] ${item.message}`)
      }
      if (diagnostics.length > MAX_DIAGNOSTICS) {
        lines.push(`${path}: mais ${diagnostics.length - MAX_DIAGNOSTICS} diagnósticos; use syrox_diagnostics`)
      }
    } catch (error) {
      if (signal?.aborted) break
      lines.push(`${path}: consulta Syrox indisponível (${error.message}); use syrox_diagnostics`)
    }
  }
  if (paths.length > MAX_FILES) lines.push(`Mais ${paths.length - MAX_FILES} arquivos .srx; use syrox_diagnostics`)
  return lines.length ? `\n\nDiagnósticos Syrox após edição:\n${lines.join('\n')}` : ''
}

export function attachDiagnostics(editor, lsp, root) {
  for (const name of ['edit', 'write', 'patch']) {
    if (!editor.get(name)) continue
    editor.update(name, tool => {
      const execute = tool.execute
      tool.execute = async (input, context) => {
        const result = await execute(input, context)
        if (typeof result?.content !== 'string') return result
        const feedback = await diagnosticFeedback(lsp, root, name, input, context.signal)
        return feedback ? { ...result, content: result.content + feedback } : result
      }
    })
  }
}
