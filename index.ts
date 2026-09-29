import { SyroxLsp } from './client.mjs'
import { attachDiagnostics } from './feedback.mjs'

const file = {
  type: 'object',
  properties: { path: { type: 'string', description: 'Relative or absolute .srx path inside this workspace' } },
  required: ['path'],
  additionalProperties: false,
} as const

const position = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Relative or absolute .srx path inside this workspace' },
    line: { type: 'integer', minimum: 1, description: 'One-based line number' },
    character: { type: 'integer', minimum: 1, description: 'One-based UTF-16 column' },
  },
  required: ['path', 'line', 'character'],
  additionalProperties: false,
} as const

function cursor(input: { line: number; character: number }) {
  return { line: input.line - 1, character: input.character - 1 }
}

export default {
  id: 'syrox.lsp',
  async setup(ctx) {
    const lsp = new SyroxLsp(ctx.location.directory)
    await ctx.tool.transform(editor => {
      attachDiagnostics(editor, lsp, ctx.location.directory)
      editor.namespace({ name: 'syrox', description: 'Read-only semantic queries from the Syrox language server for saved .srx files. Positions are one-based UTF-16.' })
      for (const [name, method, description] of [
        ['diagnostics', 'diagnostics', 'Get current syntax, type, and ownership diagnostics for a saved .srx file.'],
        ['reload', 'reload', 'Reload the entire project graph after external changes to imported modules or Syrox.lock, then return diagnostics for this file.'],
        ['symbols', 'textDocument/documentSymbol', 'List declarations in a saved .srx file.'],
        ['hints', 'textDocument/inlayHint', 'Get inferred types, parameter names and affine ownership hints for a saved .srx file.'],
        ['quickfixes', 'quickfixes', 'Preview versioned syntax quick fixes for a saved .srx file; does not apply edits.'],
      ] as const) {
        editor.add({
          name, description, input: file, options: { namespace: 'syrox', codemode: true },
          execute: async (input: { path: string }, context) => ({
            content: JSON.stringify(await lsp.query(input.path, method,
              method === 'textDocument/inlayHint' ? {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 2147483647, character: 2147483647 },
                },
              } : {}, context.signal)),
          }),
        })
      }
      for (const [name, method, description] of [
        ['hover', 'textDocument/hover', 'Get the checked type, documentation and ownership status at a position.'],
        ['definition', 'textDocument/definition', 'Find the definition at a position; syrox-source URIs can be read with syrox_source.'],
        ['type_definition', 'textDocument/typeDefinition', 'Find the declaration of the type at a position.'],
        ['references', 'textDocument/references', 'Find references to the symbol at a position.'],
        ['completion', 'textDocument/completion', 'Complete namespaces, types, locals and fields at a position in a saved .srx file.'],
        ['signature', 'textDocument/signatureHelp', 'Get callable parameter types and the active argument at a position.'],
      ] as const) {
        editor.add({
          name, description, input: position, options: { namespace: 'syrox', codemode: true },
          execute: async (input: { path: string; line: number; character: number }, context) => ({
            content: JSON.stringify(await lsp.query(input.path, method, {
              position: cursor(input),
              ...(method === 'textDocument/references' ? { context: { includeDeclaration: true } } : {}),
            }, context.signal)),
          }),
        })
      }
      editor.add({
        name: 'source', description: 'Read an ephemeral virtual source returned by Syrox go-to-definition.',
        input: {
          type: 'object',
          properties: { uri: { type: 'string', description: 'syrox-source URI from syrox_definition' } },
          required: ['uri'], additionalProperties: false,
        },
        options: { namespace: 'syrox', codemode: true },
        execute: async (input: { uri: string }, context) => ({
          content: JSON.stringify(await lsp.readSource(input.uri, context.signal)),
        }),
      })
    })
    return () => lsp.close()
  },
}
