/* engine-core 单元测试 —— 用桩 canvas 跑完整个时间轴，不需要浏览器。
 *
 *   node --test tests/
 *
 * 只测「绘制核心」这一层：它零 DOM 依赖，喂一个假的 2D 上下文就能跑。
 * overlay.js 依赖真实 DOM，不在这个范围内（它靠 demo/ 与真机验证）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CORE_PATH = fileURLToPath(new URL('../dsh/lib/engine-core.js', import.meta.url))

/* 2D 上下文桩：任何方法都可调用，少数需要返回值的按需伪造。
 * calls 记录被调用的方法名，用来断言「同一 t 两次绘制是否一致」。 */
function makeCtx(calls) {
  const gradient = { addColorStop() {} }
  const base = {
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    measureText: (s) => ({ width: String(s).length * 8 }),
    getImageData: (x, y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4)
      // 造一块「字形」：水平 20%~80%、垂直 35%~65% 填上不透明像素，
      // 这样字标采样那一步走的是真实路径，而不是空数组。
      const x0 = Math.floor(w * 0.2)
      const x1 = Math.ceil(w * 0.8)
      const y0 = Math.floor(h * 0.35)
      const y1 = Math.ceil(h * 0.65)
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) data[(py * w + px) * 4 + 3] = 255
      }
      return { data, width: w, height: h }
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return (...args) => { if (calls) calls.push(prop) }
    },
    set(target, prop, value) { target[prop] = value; return true },
  })
}

class FakeCanvas {
  constructor(w = 300, h = 150) { this.width = w; this.height = h }
  getContext() { return makeCtx() }
}

function loadCore() {
  const sandbox = { OffscreenCanvas: FakeCanvas, Math, console, Uint8ClampedArray }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(CORE_PATH, 'utf8'), sandbox, { filename: 'engine-core.js' })
  return sandbox.DSHBootCore
}

const core = loadCore()

function makeCore(opts = {}) {
  const calls = []
  const canvas = new FakeCanvas(opts.cw || 800, opts.ch || 600)
  const instance = core.create({
    canvas,
    ctx: makeCtx(calls),
    cw: opts.cw || 800,
    ch: opts.ch || 600,
    dpr: opts.dpr || 1,
    seed: opts.seed,
  })
  return { instance, calls, canvas }
}

test('时间轴常量单调递增，且早于 overlay 的 15 秒兜底', () => {
  const { T_LOCK, T_MORPH, T_FORM, T_REVEAL, T_END } = core
  assert.ok(T_LOCK < T_MORPH, 'T_LOCK 应在 T_MORPH 之前')
  assert.ok(T_MORPH < T_FORM, 'T_MORPH 应在 T_FORM 之前')
  assert.ok(T_FORM < T_REVEAL, 'T_FORM 应在 T_REVEAL 之前')
  assert.ok(T_REVEAL < T_END, 'T_REVEAL 应在 T_END 之前')
  assert.ok(T_END < 15, 'T_END 必须早于兜底移除的 15 秒，否则会被强制掐断')
})

test('draw 覆盖整个时间轴不抛异常', () => {
  const { instance } = makeCore()
  for (let t = -1; t <= core.T_END + 1; t += 0.05) {
    assert.doesNotThrow(() => instance.draw(t), `t=${t.toFixed(2)} 时抛异常`)
  }
  // 极端值：负数、恰好结束、远超结束
  assert.doesNotThrow(() => instance.draw(0))
  assert.doesNotThrow(() => instance.draw(core.T_END))
  assert.doesNotThrow(() => instance.draw(1e6))
})

test('同一 seed 同一 t，绘制调用序列一致（可复现）', () => {
  const a = makeCore({ seed: 42 })
  const b = makeCore({ seed: 42 })
  for (const t of [0, 1.2, 5.5, 7.3, 8.4, 9.2]) {
    a.calls.length = 0
    b.calls.length = 0
    a.instance.draw(t)
    b.instance.draw(t)
    assert.deepEqual(a.calls, b.calls, `t=${t} 两次绘制不一致`)
  }
})

test('不同 seed 会得到不同布局', () => {
  const a = makeCore({ seed: 1 })
  const b = makeCore({ seed: 2 })
  a.instance.draw(1)
  b.instance.draw(1)
  assert.notDeepEqual(a.calls, b.calls, '换 seed 后调用序列应当不同')
})

test('setTargets 后 hasTargets 为真，且仍可继续绘制', () => {
  const { instance } = makeCore()
  assert.equal(instance.hasTargets(), false, '初始不应有目标')
  instance.setTargets(
    [{ x1: 0, y1: 0, x2: 0, y2: 600 }, { x1: 0, y1: 40, x2: 800, y2: 40 }],
    [{ x: 400, y: 540, w: 300, h: 60, r: 8 }],
  )
  assert.equal(instance.hasTargets(), true)
  for (let t = core.T_MORPH - 0.2; t <= core.T_END; t += 0.1) {
    assert.doesNotThrow(() => instance.draw(t), `带目标时 t=${t.toFixed(2)} 抛异常`)
  }
})

test('setTargets 传空数组不应崩，也不应把已有目标清掉', () => {
  const { instance } = makeCore()
  instance.setTargets([{ x1: 0, y1: 0, x2: 0, y2: 600 }], [])
  assert.equal(instance.hasTargets(), true)
  assert.doesNotThrow(() => instance.setTargets([], []))
  assert.doesNotThrow(() => instance.draw(core.T_MORPH + 0.3))
})

test('resize 之后按新尺寸绘制', () => {
  const { instance, canvas } = makeCore({ cw: 800, ch: 600, dpr: 1 })
  assert.doesNotThrow(() => instance.resize(1200, 800, 2))
  assert.equal(canvas.width, 1200 * 2, 'canvas 宽度应按 dpr 放大')
  assert.equal(canvas.height, 800 * 2, 'canvas 高度应按 dpr 放大')
  for (let t = 0; t <= core.T_END; t += 0.25) {
    assert.doesNotThrow(() => instance.draw(t))
  }
})

test('界面还没挂载（没有任何目标）也能跑完全程', () => {
  const { instance } = makeCore()
  for (let t = 0; t <= core.T_END; t += 0.1) {
    assert.doesNotThrow(() => instance.draw(t), `无目标时 t=${t.toFixed(2)} 抛异常`)
  }
})

test('version 与包清单一致', () => {
  const pkg = JSON.parse(readFileSync(
    fileURLToPath(new URL('../dsh/package.json', import.meta.url)), 'utf8'))
  assert.equal(core.version, pkg.version, 'engine-core 的 version 应与 dsh/package.json 一致')
})
