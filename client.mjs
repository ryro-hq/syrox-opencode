import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const TIMEOUT = 20_000
const MAX_FRAME = 4 * 1024 * 1024

export function inside(root, file) {
  const part = relative(root, file)
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}

export async function projectRoot(file, workspace, stdRoot) {
  if (stdRoot && inside(stdRoot, file)) return { root: stdRoot, mode: 'standard-library' }
  const bundledSources = join(workspace, 'std')
  if (existsSync(join(bundledSources, 'main.srx')) && inside(bundledSources, file)) {
    return { root: bundledSources, mode: 'standard-library' }
  }
  let current = dirname(file)
  while (inside(workspace, current)) {
    if (existsSync(join(current, 'main.srx'))) return { root: current, mode: 'project' }
    if (current === workspace) break
    current = dirname(current)
  }
  return { root: workspace, mode: 'project' }
}

export function executable(workspace) {
  if (process.env.SYROX_LSP_BIN) return process.env.SYROX_LSP_BIN
  const local = join(workspace, 'target', 'release', 'srx')
  return existsSync(local) ? local : 'srx'
}

export class LspClient {
  constructor(root, mode, binary = executable(root)) {
    this.root = root
    this.mode = mode
    this.binary = binary
    this.child = null
    this.pending = new Map()
    this.documents = new Map()
    this.diagnostics = new Map()
    this.waiters = new Map()
    this.next = 0
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.serial = Promise.resolve()
  }

  async start() {
    this.child = spawn(this.binary, ['lsp', this.root], { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', chunk => this.receive(chunk))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.stderr.on('data', () => {})
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => this.fail(new Error(`srx lsp exited (${code ?? signal})`)))
    await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { workspaceEdit: { documentChanges: true } },
        textDocument: {
          codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } },
          },
        },
      },
      initializationOptions: {
        workspaceMode: this.mode,
        inlayHints: { types: true, parameters: true, ownership: true },
      },
    })
    this.notify('initialized', {})
  }

  receive(chunk) {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        if (this.buffer.length > 8192) this.fail(new Error('LSP header too large'))
        return
      }
      const header = this.buffer.subarray(0, end).toString('ascii')
      const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)]
      if (lengths.length !== 1 || Number(lengths[0][1]) > MAX_FRAME) {
        this.fail(new Error('Invalid LSP Content-Length'))
        return
      }
      const length = Number(lengths[0][1])
      if (this.buffer.length < end + 4 + length) return
      const body = this.buffer.subarray(end + 4, end + 4 + length)
      this.buffer = this.buffer.subarray(end + 4 + length)
      try {
        this.message(JSON.parse(body.toString('utf8')))
      } catch (error) {
        this.fail(error)
        return
      }
    }
  }

  message(value) {
    if (value.method === 'textDocument/publishDiagnostics') {
      const { uri, version, diagnostics } = value.params
      this.diagnostics.set(uri, { version, diagnostics })
      for (const waiter of this.waiters.get(uri) ?? []) {
        if (waiter.version === version) waiter.resolve(diagnostics)
      }
      return
    }
    if (value.id !== undefined && (value.result !== undefined || value.error !== undefined)) {
      const pending = this.pending.get(value.id)
      if (!pending) return
      if (value.error) pending.reject(new Error(`LSP ${value.error.code}: ${value.error.message}`))
      else pending.resolve(value.result)
      return
    }
    // Acknowledge unexpected server requests so they cannot stall the server.
    if (value.id !== undefined && value.method) {
      this.send({ jsonrpc: '2.0', id: value.id, result: null })
    }
  }

  send(value) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('srx lsp is not running')
    const bytes = Buffer.from(JSON.stringify(value))
    this.child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`)
    this.child.stdin.write(bytes)
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  request(method, params, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'))
    const id = ++this.next
    return new Promise((resolveResult, rejectResult) => {
      const finish = (callback, value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
        callback(value)
      }
      const resolve = value => finish(resolveResult, value)
      const reject = error => finish(rejectResult, error)
      const abort = () => {
        try { this.notify('$/cancelRequest', { id }) } catch {}
        reject(signal.reason ?? new Error('Cancelled'))
      }
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT)
      this.pending.set(id, { resolve, reject })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) { reject(error) }
    })
  }

  waitDiagnostics(uri, version, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'))
    return new Promise((resolveResult, rejectResult) => {
      const clear = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const remaining = (this.waiters.get(uri) ?? []).filter(item => item !== waiter)
        if (remaining.length) this.waiters.set(uri, remaining)
        else this.waiters.delete(uri)
      }
      const waiter = {
        version,
        resolve: value => { clear(); resolveResult(value) },
        reject: error => { clear(); rejectResult(error) },
      }
      const abort = () => waiter.reject(signal.reason ?? new Error('Cancelled'))
      const timer = setTimeout(() => waiter.reject(new Error('Diagnostics timed out')), TIMEOUT)
      this.waiters.set(uri, [...(this.waiters.get(uri) ?? []), waiter])
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async sync(file) {
    const uri = pathToFileURL(file).href
    const text = await readFile(file, 'utf8')
    const current = this.documents.get(uri)
    if (!current) {
      this.documents.set(uri, { version: 1, text })
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'syrox', version: 1, text } })
      return { uri, version: 1, changed: true }
    }
    if (current.text === text) return { uri, version: current.version, changed: false }
    const version = current.version + 1
    this.documents.set(uri, { version, text })
    this.notify('textDocument/didChange', {
      textDocument: { uri, version }, contentChanges: [{ text }],
    })
    this.notify('textDocument/didSave', { textDocument: { uri } })
    return { uri, version, changed: true }
  }

  async query(file, method, params = {}, signal) {
    const run = async () => {
      if (signal?.aborted) throw signal.reason ?? new Error('Cancelled')
      if (method === 'reload') {
        this.notify('workspace/didChangeWatchedFiles', {
          changes: [{ uri: pathToFileURL(file).href, type: 2 }],
        })
      }
      const { uri, version, changed } = await this.sync(file)
      if (method === 'diagnostics' || method === 'reload' || method === 'quickfixes') {
        // documentSymbol is queued until semantic analysis finishes. Diagnostics
        // are published before its response, even when the text is unchanged.
        const published = changed ? this.waitDiagnostics(uri, version, signal) : null
        await Promise.all([
          this.request('textDocument/documentSymbol', { textDocument: { uri } }, signal),
          published,
        ])
        const diagnostics = this.diagnostics.get(uri)?.diagnostics ?? []
        if (method !== 'quickfixes') return diagnostics
        const actions = new Map()
        for (const diagnostic of diagnostics.slice(0, 32)) {
          if (!diagnostic.range) continue
          const matches = await this.request('textDocument/codeAction', {
            textDocument: { uri }, range: diagnostic.range,
            context: { diagnostics: [diagnostic], only: ['quickfix'] },
          }, signal)
          for (const action of matches ?? []) {
            if (action.kind !== 'quickfix') continue
            const key = JSON.stringify(action.edit)
            actions.set(key, action)
          }
        }
        return [...actions.values()]
      }
      return this.request(method, { textDocument: { uri }, ...params }, signal)
    }
    const result = this.serial.then(run)
    this.serial = result.catch(() => {})
    return result
  }

  fail(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(error)
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(error)
    this.child?.kill()
  }

  close() {
    if (this.closed) return
    for (const uri of this.documents.keys()) {
      try { this.notify('textDocument/didClose', { textDocument: { uri } }) } catch {}
    }
    this.fail(new Error('LSP client closed'))
  }
}

export class SyroxLsp {
  constructor(workspace) {
    this.workspace = resolve(workspace)
    this.clients = new Map()
    this.starting = new Map()
  }

  async query(input, method, params, signal) {
    const file = resolve(this.workspace, input)
    if (!inside(this.workspace, file) || !file.endsWith('.srx')) {
      throw new Error('Expected a .srx file inside this OpenCode workspace')
    }
    if (!(await stat(file)).isFile()) throw new Error('Expected a .srx file')
    if (!inside(await realpath(this.workspace), await realpath(file))) {
      throw new Error('File resolves outside this OpenCode workspace')
    }
    const stdRoot = process.env.SYROX_STD_DIR ? resolve(process.env.SYROX_STD_DIR) : null
    const { root, mode } = await projectRoot(file, this.workspace, stdRoot)
    const key = `${mode}:${root}`
    let client = this.clients.get(key)
    if (!client || client.closed) {
      client = new LspClient(root, mode, executable(this.workspace))
      this.clients.set(key, client)
      const ready = client.start()
      this.starting.set(key, ready)
    }
    try {
      await this.starting.get(key)
    } catch (error) {
      client.close()
      this.clients.delete(key)
      this.starting.delete(key)
      throw error
    }
    this.starting.delete(key)
    try {
      return await client.query(file, method, params, signal)
    } catch (error) {
      if (client.closed) this.clients.delete(key)
      throw error
    }
  }

  async readSource(uri, signal) {
    if (!uri.startsWith('syrox-source:')) throw new Error('Expected a syrox-source URI')
    for (const client of this.clients.values()) {
      if (client.closed) continue
      try { return await client.request('syrox/readSource', { uri }, signal) }
      catch (error) {
        if (!String(error).includes('unknown or expired virtual source URI')) throw error
      }
    }
    throw new Error('Virtual source expired; request definition again')
  }

  notifyChanges(paths) {
    const changed = paths.map(path => resolve(this.workspace, path))
    for (const client of this.clients.values()) {
      if (client.closed) continue
      const changes = changed.filter(file => inside(client.root, file)).map(file => ({
        uri: pathToFileURL(file).href, type: existsSync(file) ? 2 : 3,
      }))
      if (changes.length && !this.starting.has(`${client.mode}:${client.root}`)) {
        try { client.notify('workspace/didChangeWatchedFiles', { changes }) } catch {}
      }
    }
  }

  close() {
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
  }
}
