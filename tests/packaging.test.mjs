/* 包结构与注入不变量 —— 这些错了不会在运行时立刻报，但会在用户机器上出事。
 *
 *   node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')
const has = (rel) => existsSync(new URL(rel, ROOT))

const INJECTED = ['dsh/lib/boot.css', 'dsh/lib/overlay.js', 'dsh/lib/engine-core.js']

test('注入资产里不得出现 </script（否则会把宿主页面截断）', () => {
  for (const rel of INJECTED) {
    const text = read(rel)
    // 大小写不敏感：浏览器关闭 script 标签是不区分大小写的，
    // 而 lib/index.js 的守卫只查小写，这里多查一层。
    assert.ok(
      !/<\/script/i.test(text),
      `${rel} 含有 </script，index.js 的注入守卫会抛错、整个开屏层会被跳过`,
    )
  }
})

test('dsh/package.json 的 main 指向真实文件', () => {
  const pkg = JSON.parse(read('dsh/package.json'))
  assert.equal(typeof pkg.main, 'string')
  const mainPath = pkg.main.replace(/^\.\//, '')
  assert.ok(has('dsh/' + mainPath), `main 指向的文件不存在: dsh/${mainPath}`)
  assert.ok(has('dsh/' + pkg.exports['.'].replace(/^\.\//, '')), 'exports["."] 指向的文件不存在')
})

test('两处 package.json 版本一致', () => {
  const root = JSON.parse(read('package.json'))
  const plugin = JSON.parse(read('dsh/package.json'))
  assert.equal(root.version, plugin.version, '根包与插件清单的 version 必须一致')
})

test('install.mjs 的 patch 标记成对，且与 README 描述一致', () => {
  const src = read('install.mjs')
  assert.ok(src.includes("const BEGIN = '# dsh-boot-particles (install.mjs) --- BEGIN'"), 'BEGIN 标记被改动')
  assert.ok(src.includes("const END = '# dsh-boot-particles (install.mjs) --- END'"), 'END 标记被改动')
  // stripBlock 必须同时用到两个标记，否则卸载会留下半个块
  assert.ok(src.includes('line.trim() === BEGIN') && src.includes('line.trim() === END'))
  // 改 patch 之前必须先落一份备份，且备份名要能认出来是哪个插件留的
  assert.ok(src.includes('.bak-boot-particles'), '缺少备份文件名后缀')
  assert.ok(src.includes('copyFileSync(patchPath, backupPath)'), '改 patch 前应先备份')
})

test('不得残留占位符', () => {
  const files = ['package.json', 'dsh/package.json', 'README.md', 'LICENSE', 'install.mjs']
  for (const rel of files) {
    const text = read(rel)
    assert.ok(!/<your-name>|<Your Name>/i.test(text), `${rel} 仍有占位符`)
  }
})

test('README 引用的预览图都存在', () => {
  const readme = read('README.md')
  const refs = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1])
  assert.ok(refs.length > 0, 'README 里应当有预览图')
  for (const rel of refs) {
    assert.ok(has(rel), `README 引用的图片不存在: ${rel}`)
  }
})

test('demo 引用的插件文件都存在', () => {
  const html = read('demo/index.html')
  const refs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
  assert.ok(refs.length > 0, 'demo 应当引用引擎与外壳')
  for (const rel of refs) {
    assert.ok(has('demo/' + rel), `demo 引用的脚本不存在: ${rel}`)
  }
})
