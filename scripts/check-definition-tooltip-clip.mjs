#!/usr/bin/env node
/**
 * Red/green check: definition tooltips inside .intel-table-wrap must not be
 * clipped by overflow:auto (Creator Dossier Index symptom).
 *
 * Usage: node scripts/check-definition-tooltip-clip.mjs
 * Exit 0 = visible, exit 1 = clipped/hidden.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'scripts/fixtures/definition-tooltip-clip.html')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const result = spawnSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--virtual-time-budget=2000',
  '--dump-dom',
  `file://${fixture}`,
], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
})

const html = result.stdout || ''
if (!html) {
  console.error(result.stderr || 'Chrome headless produced no DOM dump')
  process.exit(2)
}

const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
const outMatch = html.match(/<pre id="out">([\s\S]*?)<\/pre>/)
let parsed = null
try {
  parsed = outMatch ? JSON.parse(outMatch[1]) : null
} catch {
  parsed = null
}

console.log(JSON.stringify({ title, ...parsed }, null, 2))
if (title !== 'PASS' || !parsed?.visible) {
  process.exit(1)
}
