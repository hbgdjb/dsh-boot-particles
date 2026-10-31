/* 宿主半（dsh/lib/index.js）的冒烟测试。
 *
 *   node --test tests/
 *
 * 不启动真正的 webserver：用假的 ctx 接住 webserver/index-inject 的处理器，
 * 然后拿一张空表喂给它，看注入了什么、重复调用会不会叠加。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name } from '../dsh/lib/index.js'

function fakeCtx() {
  const handlers = []
  const logs = []
  const ctx = {
    inject(services, cb) {
      assert.deepEqual(services, ['webServer'], '应当只声明依赖 webServer')
      cb({
        on(event, handler) {
          assert.equal(event, 'webserver/index-inject')
          handlers.push(handler)
        },
        logger: {
          debug: (m) => logs.push(['debug', m]),
          warn: (m) => logs.push(['warn', m]),
        },
      })
    },
  }
  return { ctx, handlers, logs }
}

test('插件名与清单一致', () => {
  assert.equal(name, 'dsh-boot-particles')
})

test('注入四行，顺序为 样式 / 标记 / 引擎 / 启动脚本', () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  assert.equal(handlers.length, 1, '应当只注册一个 index-inject 处理器')

  const table = []
  handlers[0](table)
  assert.deepEqual(table.map((r) => r.kind), ['style', 'html', 'html', 'script'])
  assert.ok(table[0].text.includes('#dsh-particle-boot'), '第一行应是首帧保护色')
  assert.ok(table[1].html.includes('dsh-particle-boot'), '第二行应是遮罩标记')
  assert.ok(table[2].html.includes('dshb-core-src'), '第三行应是引擎源码容器')
  assert.ok(table[3].text.includes('DSHBootOverlay'), '第四行应是启动脚本')
})

test('重复触发不会叠加（幂等）', () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  const table = []
  handlers[0](table)
  const once = table.length
  handlers[0](table)
  assert.equal(table.length, once, '第二次注入应当被 already 判断挡掉')
})

test('enabled / overlay 关掉时不注册处理器', () => {
  for (const config of [{ enabled: false }, { overlay: false }]) {
    const { ctx, handlers } = fakeCtx()
    apply(ctx, config)
    assert.equal(handlers.length, 0, `${JSON.stringify(config)} 时不应注入`)
  }
})

test('config 只接受与默认值同类型的值', () => {
  // 默认值是布尔，字符串属于类型不符 → 保持默认（启用）
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { enabled: 'no' })
  assert.equal(handlers.length, 1, '类型不符的值应被忽略，而不是当成 falsy')
})

test('注入表不是数组时不抛异常', () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, {})
  assert.doesNotThrow(() => handlers[0](undefined))
  assert.doesNotThrow(() => handlers[0](null))
  assert.doesNotThrow(() => handlers[0]({}))
})
