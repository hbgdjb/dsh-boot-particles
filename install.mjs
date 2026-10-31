#!/usr/bin/env node
/**
 * dsh-boot-particles - local installer for the DSH desktop app.
 *
 *   node install.mjs            install (idempotent: refreshes files, patches once)
 *   node install.mjs --dry-run  print the plan, write nothing
 *   node install.mjs --remove   remove the patch block (files stay)
 *
 * Only two things are touched:
 *   1. %USERPROFILE%\.dsh\plugins\dsh-boot-particles\  (plugin files)
 *   2. %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml  (one marked block)
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'dsh')

const home = process.env.USERPROFILE || process.env.HOME
if (!home) {
  console.error('error: USERPROFILE / HOME is not set; run this in a normal user terminal')
  process.exit(1)
}

const pluginDir = join(home, '.dsh', 'plugins', 'dsh-boot-particles')
const patchPath = join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const backupPath = patchPath + '.bak-boot-particles'

const BEGIN = '# dsh-boot-particles (install.mjs) --- BEGIN'
const END = '# dsh-boot-particles (install.mjs) --- END'

const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const remove = args.includes('--remove')

const log = (line = '') => process.stdout.write(line + '\n')

const entryUrl = pathToFileURL(join(pluginDir, 'lib', 'index.js')).href
const block = [
  BEGIN,
  '- insert:',
  '    - id: dsh-boot-particles',
  '      name: "' + entryUrl + '"',
  '      config:',
  '        enabled: true',
  '        overlay: true',
  '        playOncePerSession: true',
  END,
  '',
].join('\n')

const stripBlock = (text) => {
  const lines = text.split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    if (line.trim() === BEGIN) { inside = true; continue }
    if (line.trim() === END) { inside = false; continue }
    if (!inside) out.push(line)
  }
  return out.join('\n')
}

if (!existsSync(patchPath)) {
  console.error('error: profile patch not found: ' + patchPath)
  console.error('       is this a desktop install? open DSH once so the profile is created')
  process.exit(1)
}

const current = readFileSync(patchPath, 'utf8')
const installed = current.includes(BEGIN)

if (remove) {
  if (!installed) {
    log('nothing to remove: no dsh-boot-particles block in ' + patchPath)
    process.exit(0)
  }
  log((dry ? '[dry-run] would remove' : 'removing') + ' the patch block from ' + patchPath)
  if (!dry) writeFileSync(patchPath, stripBlock(current), 'utf8')
  log('files kept at ' + pluginDir + ' - delete the folder to finish the uninstall')
  process.exit(0)
}

// --- 1. files ---------------------------------------------------------------
const files = []
for (const name of readdirSync(join(src, 'lib'))) {
  files.push([join(src, 'lib', name), join(pluginDir, 'lib', name)])
}
files.push([join(src, 'package.json'), join(pluginDir, 'package.json')])

for (const [from, to] of files) {
  const same = existsSync(to) && readFileSync(from).equals(readFileSync(to))
  log((dry ? '[dry-run] ' : '') + (same ? 'unchanged  ' : 'write      ') + to)
  if (!dry && !same) {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

// --- 2. patch ---------------------------------------------------------------
if (installed) {
  log('patch already wired: ' + patchPath)
} else {
  log((dry ? '[dry-run] would append' : 'append') + ' the patch block to ' + patchPath)
  if (!dry) {
    if (!existsSync(backupPath)) {
      copyFileSync(patchPath, backupPath)
      log('backup written: ' + backupPath)
    } else {
      log('backup already exists: ' + backupPath)
    }
    const next = current.replace(/\s*$/, '') + '\n' + block
    writeFileSync(patchPath, next, 'utf8')
    const check = readFileSync(patchPath, 'utf8')
    if (!check.includes(BEGIN) || !check.includes(END) || !check.includes('id: dsh-boot-particles')) {
      console.error('error: patch self-check failed, restore ' + backupPath)
      process.exit(1)
    }
    log('patch verified')
  }
}

log('')
log(dry ? 'dry run: nothing was written' : 'done - fully quit DSH (tray icon too) and start it again')
