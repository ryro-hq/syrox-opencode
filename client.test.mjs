import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import plugin from './index.ts'
import { changedFiles, diagnosticFeedback } from './feedback.mjs'
import { SyroxLsp, inside, projectRoot } from './client.mjs'

const binary = process.env.SRX_BIN ?? resolve('../syrox/target/release/srx')
if (process.env.SRX_BIN && !existsSync(binary)) {
  throw new Error(`SRX_BIN does not exist: ${binary}`)
}
const withServer = existsSync(binary) ? test : test.skip

test('workspace roots and relative path containment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'syrox-plugin-root-'))
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'main.srx'), '')
    assert.deepEqual(await projectRoot(join(root, 'nested', 'a.srx'), root, null), {
      root, mode: 'project',
    })
    await mkdir(join(root, 'std'))
    await writeFile(join(root, 'std', 'main.srx'), '')
    assert.deepEqual(await projectRoot(join(root, 'std', 'main.srx'), root, null), {
      root: join(root, 'std'), mode: 'standard-library',
    })
    assert.equal(inside(root, resolve(root, '../other.srx')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

withServer('OpenCode plugin registers usable tools and rejects symlink escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'syrox-plugin-tool-'))
  const outside = await mkdtemp(join(tmpdir(), 'syrox-plugin-outside-'))
  const old = process.env.SYROX_LSP_BIN
  process.env.SYROX_LSP_BIN = binary
  let close
  t.after(async () => {
    close?.()
    if (old === undefined) delete process.env.SYROX_LSP_BIN
    else process.env.SYROX_LSP_BIN = old
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const tools = new Map()
  const builtins = new Map([
    ['edit', {
      name: 'edit',
      execute: async input => {
        await writeFile(join(root, input.path), input.text)
        return { content: 'Edit completed', metadata: { ok: true } }
      },
    }],
  ])
  close = await plugin.setup({
    location: { directory: root },
    tool: { transform(callback) {
      callback({
        namespace() {},
        add(tool) { tools.set(tool.name, tool) },
        get(name) { return builtins.get(name) },
        update(name, callback) { callback(builtins.get(name)) },
      })
    } },
  })
  assert.deepEqual([...tools.keys()], ['diagnostics', 'reload', 'symbols', 'hints', 'quickfixes', 'hover', 'definition', 'type_definition', 'references', 'completion', 'signature', 'source'])
  const path = join(root, 'main.srx')
  await writeFile(path, 'value I(int); fn run() -> I { I(1) }')
  const input = { path: 'main.srx' }
  const context = { signal: new AbortController().signal }
  const results = await Promise.all([
    tools.get('diagnostics').execute(input, context),
    tools.get('symbols').execute(input, context),
  ])
  assert.deepEqual(JSON.parse(results[0].content), [])
  assert.equal(JSON.parse(results[1].content)[0].name, 'I')
  const completed = await tools.get('completion').execute({ path: 'main.srx', line: 1, character: 32 }, context)
  assert(Array.isArray(JSON.parse(completed.content).items))
  const edited = await builtins.get('edit').execute({ path: 'main.srx', text: 'value I(int); fn run() -> I { }' }, context)
  assert.match(edited.content, /srx\.type-check/)
  assert.deepEqual(edited.metadata, { ok: true })
  const fixed = await builtins.get('edit').execute({ path: 'main.srx', text: 'value I(int); fn run() -> I { I(2) }' }, context)
  assert.match(fixed.content, /sem diagnósticos Syrox/)
  const other = await builtins.get('edit').execute({ path: 'notes.txt', text: 'test' }, context)
  assert.equal(other.content, 'Edit completed')
  await writeFile(join(outside, 'bad.srx'), '@')
  await symlink(join(outside, 'bad.srx'), join(root, 'link.srx'))
  await assert.rejects(tools.get('diagnostics').execute({ path: 'link.srx' }, context), /outside/)
})

test('patch feedback recognizes changed files, not example text in patch bodies', () => {
  const input = { patchText: `*** Begin Patch
*** Update File: std/main.srx
@@
+*** Add File: imaginary.srx
*** Move to: std/renamed.srx
*** Delete File: std/removed.srx
*** End Patch` }
  assert.deepEqual(changedFiles('patch', input), ['std/main.srx', 'std/renamed.srx', 'std/removed.srx'])
})

test('lock changes notify the graph while ordinary source updates use didSave', async () => {
  const root = await mkdtemp(join(tmpdir(), 'syrox-plugin-notify-'))
  try {
    const seen = []
    const lsp = {
      notifyChanges(paths) { seen.push(paths) },
      async query() { return [] },
    }
    await writeFile(join(root, 'main.srx'), 'fn run() {}')
    await diagnosticFeedback(lsp, root, 'edit', { path: 'main.srx' })
    assert.deepEqual(seen, [])
    await diagnosticFeedback(lsp, root, 'write', { path: 'Syrox.lock' })
    assert.deepEqual(seen, [['Syrox.lock']])
    const deleted = await diagnosticFeedback(lsp, root, 'patch', {
      patchText: '*** Begin Patch\n*** Delete File: missing.srx\n*** End Patch',
    })
    assert.deepEqual(seen, [['Syrox.lock'], ['missing.srx']])
    assert.match(deleted, /arquivo removido/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

withServer('real Syrox stdio transport, edits, hover and virtual std navigation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'syrox-plugin-protocol-'))
  const old = process.env.SYROX_LSP_BIN
  process.env.SYROX_LSP_BIN = binary
  const lsp = new SyroxLsp(root)
  t.after(async () => {
    lsp.close()
    if (old === undefined) delete process.env.SYROX_LSP_BIN
    else process.env.SYROX_LSP_BIN = old
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'main.srx')
  const text = 'fn example() -> std::PackageId { std::PackageId("hello") }\n'
  await writeFile(path, text)
  assert.deepEqual(await lsp.query('main.srx', 'diagnostics', {}), [])
  const server = [...lsp.clients.values()][0]
  const notify = server.notify.bind(server)
  const watched = []
  server.notify = (method, params) => {
    if (method === 'workspace/didChangeWatchedFiles') {
      watched.push(...params.changes)
    }
    notify(method, params)
  }
  lsp.notifyChanges(['Syrox.lock'])
  lsp.notifyChanges(['removed.srx'])
  assert(watched[0].uri.endsWith('/Syrox.lock'))
  assert.equal(watched[0].type, 3)
  assert(watched[1].uri.endsWith('/removed.srx'))
  assert.equal(watched[1].type, 3)
  const at = text.indexOf('std::PackageId')
  const definition = await lsp.query('main.srx', 'textDocument/definition', {
    position: { line: 0, character: at },
  })
  assert.match(definition.uri, /^syrox-source:/)
  assert.match((await lsp.readSource(definition.uri)).text, /PackageId/)
  const hover = await lsp.query('main.srx', 'textDocument/hover', {
    position: { line: 0, character: at + 5 },
  })
  assert.match(hover.contents.value, /PackageId/)
  await writeFile(path, 'fn example() -> std::PackageId { }\n')
  assert((await lsp.query('main.srx', 'diagnostics', {})).some(x => x.severity === 1))
  await writeFile(path, text)
  assert.deepEqual(await lsp.query('main.srx', 'diagnostics', {}), [])
  await assert.rejects(lsp.readSource(definition.uri), /expired/)
  await assert.rejects(lsp.query('../outside.srx', 'diagnostics', {}), /inside/)
})

withServer('explicit reload sees external edits to an imported source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'syrox-plugin-reload-'))
  const old = process.env.SYROX_LSP_BIN
  process.env.SYROX_LSP_BIN = binary
  const lsp = new SyroxLsp(root)
  t.after(async () => {
    lsp.close()
    if (old === undefined) delete process.env.SYROX_LSP_BIN
    else process.env.SYROX_LSP_BIN = old
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'recipes'))
  const imported = join(root, 'recipes', 'one.srx')
  await writeFile(imported, 'pub value I(int); pub fn make() -> I { I(1) }')
  await writeFile(join(root, 'main.srx'), 'inputs { lib = "modules:recipes"; } fn run() -> lib::one::I { lib::one::make() }')
  assert.deepEqual(await lsp.query('main.srx', 'diagnostics', {}), [])
  await writeFile(imported, 'pub value I(int); pub fn renamed() -> I { I(1) }')
  const errors = await lsp.query('main.srx', 'reload', {})
  assert(errors.some(item => item.code === 'srx.resolution'))
  await writeFile(imported, 'pub value I(int); pub fn make() -> I { I(1) }')
  assert.deepEqual(await lsp.query('main.srx', 'reload', {}), [])
})

withServer('hints and quickfixes use negotiated capabilities without editing disk', async t => {
  const root = await mkdtemp(join(tmpdir(), 'syrox-plugin-hints-'))
  const old = process.env.SYROX_LSP_BIN
  process.env.SYROX_LSP_BIN = binary
  const lsp = new SyroxLsp(root)
  t.after(async () => {
    lsp.close()
    if (old === undefined) delete process.env.SYROX_LSP_BIN
    else process.env.SYROX_LSP_BIN = old
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'main.srx')
  const broken = 'value S(str); outputs { name: S = S("😀") }'
  await writeFile(path, broken)
  const actions = await lsp.query('main.srx', 'quickfixes', {})
  assert.equal(actions.length, 1)
  assert.equal(actions[0].title, 'Insert `;`')
  assert.equal(actions[0].edit.documentChanges[0].textDocument.version, 1)
  assert.equal(await readFile(path, 'utf8'), broken)
  await writeFile(path, 'value I(int); fn run() { let item = I(1); }')
  assert.deepEqual(await lsp.query('main.srx', 'quickfixes', {}), [])
  const hints = await lsp.query('main.srx', 'textDocument/inlayHint', {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 2147483647, character: 2147483647 },
    },
  })
  assert(hints.some(hint => hint.label === ': I'))
})
