import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const root = await mkdtemp(join(tmpdir(), 'syrox-opencode-host-'))
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 90000,
  })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error ?? ''}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

try {
  const files = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], { cwd: resolve('.') }))
  const archive = join(root, (Array.isArray(files) ? files[0] : files['syrox-opencode']).filename)
  run('npm', ['install', '--no-save', '--ignore-scripts', '--no-package-lock', archive])
  await writeFile(join(root, 'opencode.jsonc'), JSON.stringify({
    plugins: ['./node_modules/syrox-opencode'],
  }))
  await writeFile(join(root, 'main.srx'), 'fn example() {}\n')
  await mkdir(join(root, 'config'))
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_DB: ':memory:',
    SYROX_LSP_BIN: process.env.SRX_BIN,
  }
  const binary = process.env.OPENCODE_BIN ?? 'opencode'
  const port = await freePort()
  const server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--log-level', 'debug', '--print-logs'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  server.stdout.on('data', chunk => { logs += chunk })
  server.stderr.on('data', chunk => { logs += chunk })
  try {
    const url = `http://127.0.0.1:${port}`
    let password
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error('OpenCode exited before answering /api/info')
      password = logs.match(/server password (\S+)/)?.[1]
      if (!password) { await delay(100); continue }
      try {
        const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }
        if ((await fetch(`${url}/api/info`, { headers })).ok) break
      } catch {}
      if (attempt === 99) throw new Error('OpenCode did not start within 10 seconds')
      await delay(100)
    }
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    }
    const api = async (method, path, body) => {
      const response = await fetch(`${url}${path}`, { method, headers, body: body && JSON.stringify(body) })
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
      return response.json()
    }
    const config = await api('GET', '/api/config')
    assert(JSON.stringify(config).includes('syrox-opencode'), JSON.stringify(config))
    await api('POST', '/api/session', {})
    let plugins
    for (let attempt = 0; attempt < 100; attempt++) {
      plugins = await api('GET', '/api/plugin')
      if (plugins.data?.some(plugin => plugin.id === 'syrox.lsp')) break
      await delay(100)
    }
    assert(plugins.data?.some(plugin => plugin.id === 'syrox.lsp'), JSON.stringify({ plugins, logs: logs.replace(/server password \S+/, 'server password [redacted]') }))
  } finally {
    server.kill()
    await new Promise(resolve => server.once('exit', resolve))
  }
  const installed = JSON.parse(await readFile(join(root, 'node_modules/syrox-opencode/package.json'), 'utf8'))
  assert.equal(installed.name, 'syrox-opencode')
} finally {
  await rm(root, { recursive: true, force: true })
}
