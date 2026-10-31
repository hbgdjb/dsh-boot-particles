/**
 * DSH particle boot — host half.
 *
 * Contributes one full-screen transition layer to every index render through
 * the webserver's structured injection table:
 *
 *   lib/index.js        this module
 *   lib/boot.css        first-paint guard (opaque until the shell styles load)
 *   lib/overlay.js      DOM shell + timeline, inlined and executed
 *   lib/engine-core.js  canvas drawing, shipped as text so it can run in a
 *                       worker over an OffscreenCanvas (main thread stays free)
 *
 * The layer covers the shell while it mounts, plays the particle sequence, then
 * opens a radial hole in its own veil so the already-mounted app appears. It
 * dispatches `hsx:done` and removes itself; nothing else in the app is touched.
 */

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-boot-particles'
const LIB_DIR = new URL('./', import.meta.url)
const assets = new Map()

const DEFAULTS = {
  enabled: true,
  overlay: true,
  playOncePerSession: true,
}

function readAsset(name) {
  const path = fileURLToPath(new URL(name, LIB_DIR))
  const stat = statSync(path)
  const cached = assets.get(name)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.text
  }
  const text = readFileSync(path, 'utf8')
  assets.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  return text
}

function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = source[key]
    if (value === undefined) continue
    if (typeof value === typeof DEFAULTS[key]) config[key] = value
  }
  return config
}

function bootMarkup() {
  return '<div id="dsh-particle-boot" data-hsx-root class="dshb-root" role="progressbar"'
    + ' aria-label="正在载入工作台" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>'
}

function coreTag() {
  const src = readAsset('engine-core.js')
  if (src.includes('</script')) {
    throw new Error('coreTag: engine source must not contain a closing script tag')
  }
  return '<script type="text/plain" id="dshb-core-src">' + src + '</script>'
}

function bootScript(config) {
  const shell = readAsset('overlay.js')
  const body = '(function(){'
    + 'var cfg=' + JSON.stringify(config) + ';'
    + 'var host=document.getElementById("dsh-particle-boot");'
    + 'if(!host)return;'
    + 'if(window.__DSH_PARTICLE_BOOT__)return;window.__DSH_PARTICLE_BOOT__=1;'
    + 'var params=new URLSearchParams(location.search);'
    + 'var mode=params.get("boot")||"auto";'
    + 'if(mode==="off"){host.remove();return;}'
    + 'var once=cfg.playOncePerSession!==false;'
    + 'var played=false;try{played=sessionStorage.getItem("dsh-particle-boot-played")==="1"}catch(e){}'
    + 'if(played&&once&&mode!=="force"){host.remove();return;}'
    + 'try{sessionStorage.setItem("dsh-particle-boot-played","1")}catch(e){}'
    + 'document.documentElement.setAttribute("data-hsx-boot","");'
    + shell
    + ';if(!window.DSHBootOverlay){host.remove();return;}'
    + 'var handle=window.DSHBootOverlay.play({host:host});'
    + 'if(!handle){host.remove();return;}'
    + 'window.__HSX__={perf:{dismissed:false},dismiss:function(){window.__HSX__.perf.dismissed=true;handle.remove();}};'
    + 'handle.promise.then(function(){window.__HSX__.perf.done=true;});'
    + 'setTimeout(function(){try{var el=document.getElementById("dsh-particle-boot");'
    + 'if(el&&el.parentNode)el.parentNode.removeChild(el);'
    + 'document.documentElement.removeAttribute("data-hsx-boot");}catch(e){}},15000);'
    + '})();'
  if (body.includes('</script')) {
    throw new Error('bootScript: generated body must not contain a closing script tag')
  }
  return body
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled || !config.overlay) return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      const already = table.some((row) => row.kind === 'html' && typeof row.html === 'string' && row.html.includes('dsh-particle-boot'))
      if (already) return
      table.push({ kind: 'style', text: readAsset('boot.css') })
      table.push({ kind: 'html', placement: 'body', html: bootMarkup() })
      table.push({ kind: 'html', placement: 'body', html: coreTag() })
      table.push({ kind: 'script', placement: 'body', text: bootScript(config) })
    })
    webCtx.logger?.debug?.(`${NAME}: particle transition layer on`)
  })
}

export const name = NAME
