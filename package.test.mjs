import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

test('Git package includes only the plugin entrypoint and its runtime dependencies', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' })
  const parsed = JSON.parse(output)
  const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  const paths = pack.files.map(file => file.path).sort()
  assert.deepEqual(paths, [
    'LICENSE', 'README.txt', 'client.mjs', 'feedback.mjs', 'index.ts', 'package.json',
  ])
})
