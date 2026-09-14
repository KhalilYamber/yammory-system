// SPDX-License-Identifier: Apache-2.0
// test/client-harness.mjs — client/client.js 半侧测试桩（测试专用，不进 npm 包）。
//
// 客户端半侧跑在 react + react-dom/client + 官方控件库上，而仓库本身不带 React
// （它是宿主浏览器平台的种子模块）。这里提供三件最小等价物，让面板行为仍可在
// Node 里被断言：
//   · 迷你 React：createElement / useState / useEffect / useRef（含依赖比较）
//   · 迷你 react-dom/client：createRoot().render，把元素树落到假 DOM，并把
//     onClick / onChange / onInput 接成 addEventListener（click() 可直接触发）
//   · 官方控件库的占位件：Button/Input/Tag/Pill/StateDot/Switch/Tooltip/Modal
//     （只保留 props 与可见文字；观感由浏览器里的人眼终验）
// 断言口径因此从「innerHTML 里找字符串」改成「在渲染出来的元素树上找节点」。

import assert from 'node:assert/strict'

/** 依次让出事件循环（面板的 fetch 链是若干 promise 接续）。 */
export async function settle() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 官方控件占位件共用的标识（测试凭它找节点）。 */
export const UI = {
  button: 'ui-button',
  input: 'ui-input',
  tag: 'ui-tag',
  stateDot: 'ui-statedot',
  switch: 'ui-switch',
  tooltip: 'ui-tooltip',
}

/** 迷你 React：元素 = {type, props, children} 纯对象；hooks 按「树位置」归位（与 React 同口径）。 */
function makeHooks() {
  /** @type {Array<{hooks: any[], effects: any[], path: string[]}>} */
  const stack = []
  /** @type {Map<string, {hooks: any[], effects: any[]}>} */
  const frames = new Map()
  const positionCounters = new Map()
  /** @type {Array<{frame: object, index: number, queued: any[]}>} */
  const pendingSets = []
  /** @type {Array<object>} */
  const queuedEffects = []

  const sameDeps = (/** @type {any[] | undefined} */ a, /** @type {any[] | undefined} */ b) => {
    if (a === undefined || b === undefined) return false
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  }

  return {
    pendingSets,
    queuedEffects,
    /** 进入一个函数组件（按路径取回或新建帧）。 */
    enter(/** @type {Function} */ type) {
      const parentPath = stack.length === 0 ? '' : stack[stack.length - 1].path
      const slot = `${parentPath}>${type.name || 'anon'}`
      const position = positionCounters.get(slot) ?? 0
      positionCounters.set(slot, position + 1)
      const path = `${slot}#${position}`
      let frame = frames.get(path)
      if (frame === undefined) {
        frame = { hooks: [], effects: [] }
        frames.set(path, frame)
      }
      stack.push({ frame, cursor: { hooks: 0, effects: 0 }, path })
    },
    exit() { stack.pop() },
    /** 一个渲染批次开始：位置计数清零，未出现的帧保留（下次出现时仍是同一个实例）。 */
    beginPass() { positionCounters.clear() },
    useState(/** @type {any} */ initial) {
      const top = stack[stack.length - 1]
      const index = top.cursor.hooks
      top.cursor.hooks += 1
      if (top.frame.hooks.length <= index) top.frame.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (/** @type {any} */ next) => {
        pendingSets.push({ frame: top.frame, index, queued: [typeof next === 'function' ? next(top.frame.hooks[index]) : next] })
      }
      return [top.frame.hooks[index], setState]
    },
    useEffect(/** @type {Function} */ effect, /** @type {any[] | undefined} */ deps) {
      const top = stack[stack.length - 1]
      const index = top.cursor.effects
      top.cursor.effects += 1
      const previous = top.frame.effects[index] ?? null
      if (previous !== null && sameDeps(previous.deps, deps)) return
      if (previous !== null && typeof previous.cleanup === 'function') previous.cleanup()
      const entry = { deps, cleanup: undefined, effect }
      top.frame.effects[index] = entry
      queuedEffects.push(entry)
    },
    useRef(/** @type {any} */ initial) {
      const top = stack[stack.length - 1]
      const index = top.cursor.hooks
      top.cursor.hooks += 1
      if (top.frame.hooks.length <= index) top.frame.hooks[index] = { current: initial }
      return top.frame.hooks[index]
    },
    useCallback(/** @type {Function} */ fn, /** @type {any[] | undefined} */ deps) {
      const top = stack[stack.length - 1]
      const index = top.cursor.hooks
      top.cursor.hooks += 1
      const previous = top.frame.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      top.frame.hooks[index] = { deps, value: fn }
      return fn
    },
  }
}

export function makeDom() {
  /** @type {Map<string, any>} */
  const byId = new Map()
  /** @type {WeakMap<object, Map<string, Function[]>>} */
  const listeners = new WeakMap()
  /** @type {string[]} */
  const styleText = []

  function makeElement(/** @type {string} */ tag) {
    /** @type {any} */
    const element = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      title: '',
      placeholder: '',
      disabled: false,
      value: '',
      style: {},
      dataset: {},
      attributes: {},
      children: [],
      handlers: {},
      listening: {},
      __texts: [],
      appendChild(/** @type {any} */ child) {
        element.children.push(child)
        if (typeof child.id === 'string' && child.id.length > 0) byId.set(child.id, child)
        if (typeof child.attributes?.['data-test'] === 'string') byId.set(child.attributes['data-test'], child)
        return child
      },
      setAttribute(/** @type {string} */ name, /** @type {string} */ value) {
        element.attributes[name] = String(value)
        if (name === 'data-test') byId.set(String(value), element)
      },
      remove() {
        for (const parent of [document.head, document.body]) {
          const index = parent.children.indexOf(element)
          if (index >= 0) parent.children.splice(index, 1)
        }
      },
      addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) {
        const table = listeners.get(element) ?? new Map()
        table.set(type, [...(table.get(type) ?? []), fn])
        listeners.set(element, table)
      },
      dispatch(/** @type {string} */ type, /** @type {object} */ event) {
        for (const fn of listeners.get(element)?.get(type) ?? []) fn({ target: element, ...event })
      },
      click() { element.dispatch('click', {}) },
      querySelector() { return null },
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    }
    return element
  }

  const document = {
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: (/** @type {string} */ tag) => {
      const element = makeElement(tag)
      if (tag === 'style') {
        Object.defineProperty(element, 'textContent', {
          get: () => styleText.join('\n'),
          set: (/** @type {string} */ value) => { styleText.push(String(value)) },
        })
      }
      return element
    },
    getElementById: (/** @type {string} */ id) => byId.get(id) ?? null,
    querySelector: () => null,
  }
  const win = {
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: { load(/** @type {object} */ definition) { win.plugin = definition } },
    plugin: /** @type {any} */ (null),
  }
  return { document, window: win, byId, styleText, makeElement }
}

/** 渲染器：元素树 → 假 DOM（函数组件按 hooks 帧渲染；同位置同类型的节点就地复用）。 */
function makeRenderer(dom, hooks) {
  const { document } = dom

  // 事件只挂一次：包装函数按「节点+事件」缓存，重渲染只换 node.handlers 里的当前回调。
  // （本轮渲染若重新 addEventListener，同一个节点就会叠加多个监听，一次点击发多次。）
  const setListener = (/** @type {any} */ node, /** @type {string} */ type, /** @type {any} */ fn) => {
    if (typeof fn !== 'function') return
    node.handlers[type] = fn
    if (node.listening[type] === true) return
    node.listening[type] = true
    node.addEventListener(type, (/** @type {any} */ event) => node.handlers[type](event))
  }
  const applyProps = (/** @type {any} */ node, /** @type {any} */ props) => {
    if (props.id !== undefined) { node.id = String(props.id); dom.byId.set(node.id, node) }
    if (props.className !== undefined) node.className = String(props.className)
    if (props.title !== undefined) node.title = String(props.title)
    if (props.placeholder !== undefined) node.placeholder = String(props.placeholder)
    if (props.defaultValue !== undefined && node.value === '') node.value = String(props.defaultValue)
    if (props.value !== undefined) node.value = String(props.value)
    if (props.disabled !== undefined) node.disabled = props.disabled === true
    if (props.style !== undefined) node.style = props.style
    if (props['data-test'] !== undefined) node.setAttribute('data-test', String(props['data-test']))
    setListener(node, 'click', props.onClick)
    setListener(node, 'change', props.onChange)
    setListener(node, 'input', props.onInput)
  }

  /** 一次渲染的游标：按顺序取兄弟节点复用（与 React 的位置口径一致）。 */
  let cursor = null
  const nextSibling = (/** @type {any} */ parent, /** @type {string} */ kind) => {
    const index = cursor[parent.__key] ?? 0
    cursor[parent.__key] = index + 1
    const existing = parent.children[index]
    if (existing !== undefined && existing.__kind === kind) return existing
    const created = document.createElement(kind)
    created.__kind = kind
    created.handlers = {}
    created.listening = {}
    created.__key = `${parent.__key}/${index}:${kind}`
    parent.children[index] = created
    return created
  }

  const render = (/** @type {any} */ element, /** @type {any} */ parent) => {
    if (element === null || element === undefined || element === false) return
    if (typeof element === 'string' || typeof element === 'number') {
      parent.__texts.push(String(element))
      return
    }
    const { type, props } = element
    const children = Array.isArray(element.children) ? element.children : (element.children === undefined ? [] : [element.children])
    if (type === Symbol.for('react.fragment')) {
      for (const child of children) render(child, parent)
      return
    }
    if (typeof type === 'function') {
      hooks.enter(type)
      let tree
      try {
        tree = type(props ?? {})
      } finally {
        hooks.exit()
      }
      render(tree, parent)
      return
    }
    const node = nextSibling(parent, typeof type === 'string' ? type : 'node')
    applyProps(node, props ?? {})
    node.__texts = []
    cursor[node.__key] = 0
    for (const child of children) render(child, node)
    node.children.length = cursor[node.__key] ?? 0
    node.textContent = node.__texts.join('')
  }

  /** 真 DOM 的 textContent 是深度累积的；假 DOM 照同语义给一份只读视图。 */
  const syncText = (/** @type {any} */ node) => {
    for (const child of node.children) syncText(child)
    node.textContent = node.__texts.join('') + node.children.map((/** @type {any} */ child) => child.textContent).join('')
  }

  return function renderTree(/** @type {any} */ element, /** @type {any} */ container) {
    cursor = { root: 0 }
    container.__key = 'root'
    container.__texts = []
    render(element, container)
    container.children.length = cursor.root ?? 0
    container.__texts = container.__texts ?? []
    syncText(container)
  }
}

/** 官方控件库占位件：只留 props 与可见文字（观感由人眼终验）。 */
function makePrimitives() {
  const stub = (/** @type {string} */ name) => function stubComponent(/** @type {object} */ props) {
    const kids = Array.isArray(props.children) ? props.children : (props.children === undefined ? [] : [props.children])
    const type = name === 'Input' ? 'input' : 'div'
    const test = props['data-test'] ?? UI[name.toLowerCase()] ?? `ui-${name.toLowerCase()}`
    return { type, props: { ...props, 'data-test': test }, children: kids }
  }
  return {
    Button: stub('Button'),
    Input: stub('Input'),
    Pill: stub('Pill'),
    Tag: stub('Tag'),
    StateDot: stub('StateDot'),
    Switch: stub('Switch'),
    Tooltip: function tooltipStub(/** @type {any} */ props) { return props.children },
    Modal: stub('Modal'),
  }
}

/**
 * 挂载客户端半侧：装好假 DOM／迷你 React／官方控件占位件，跑 apply，等首屏落定。
 * @param {(url: string, init?: object) => Promise<object>} fetchImpl - 测试提供的响应表。
 * @returns {Promise<object>} 断言面（dom／calls／slots／render）。
 */
export async function mountClient(fetchImpl) {
  const dom = makeDom()
  const hooks = makeHooks()
  const renderTree = makeRenderer(dom, hooks)
  /** @type {Array<{url: string, method: string}>} */
  const calls = []
  /** @type {any} */
  let rootContainer = null

  const commit = (/** @type {any} */ element) => {
    hooks.beginPass()
    renderTree(element, rootContainer)
  }
  /** @type {any} */
  let lastElement = null
  /** 跑完排队中的 effect 与 setState，直到静止（上限防打转）。 */
  const flush = () => {
    for (let round = 0; round < 8; round += 1) {
      const sets = hooks.pendingSets.splice(0, hooks.pendingSets.length)
      let changed = false
      for (const slot of sets) {
        const next = slot.queued[slot.queued.length - 1]
        if (Object.is(slot.frame.hooks[slot.index], next)) continue
        slot.frame.hooks[slot.index] = next
        changed = true
      }
      for (const entry of hooks.queuedEffects.splice(0, hooks.queuedEffects.length)) {
        const cleanup = entry.effect()
        if (typeof cleanup === 'function') entry.cleanup = cleanup
        changed = true
      }
      if (!changed) break
      commit(lastElement)
    }
  }

  const reactDomClient = {
    createRoot(/** @type {any} */ container) {
      rootContainer = container
      return {
        render(/** @type {any} */ element) {
          lastElement = element
          commit(element)
          flush()
        },
        unmount() { container.children.length = 0 },
      }
    },
  }

  const moduleFor = (/** @type {string} */ name) => {
    if (name === 'react') {
      return {
        createElement: (/** @type {any} */ type, /** @type {any} */ props, /** @type {any[]} */ ...children) => {
          // 真 React 把「第三个参数起的 children」折进 props.children；组件读的是 props.children，
          // 所以这里必须照做，否则组件拿到的 props 里没有孩子。
          const merged = { ...props }
          if (children.length > 0) merged.children = children.flat(Infinity)
          else if (props?.children !== undefined) merged.children = props.children
          return { type, props: merged, children: children.flat(Infinity) }
        },
        Fragment: Symbol.for('react.fragment'),
        useState: hooks.useState,
        useEffect: hooks.useEffect,
        useRef: hooks.useRef,
        useCallback: hooks.useCallback,
      }
    }
    if (name === 'react-dom/client') return reactDomClient
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return makePrimitives()
    assert.fail(`client 半侧 require 了未预置的模块：${name}`)
  }

  const originalFetch = globalThis.fetch
  const originalWindow = /** @type {any} */ (globalThis).window
  const originalDocument = /** @type {any} */ (globalThis).document
  ;/** @type {any} */ (globalThis).window = dom.window
  ;/** @type {any} */ (globalThis).document = dom.document
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method })
    return fetchImpl(`${method} ${url}`)
  })

  await import('../client/client.js')
  const definition = /** @type {{id: string, factory: Function}} */ (dom.window.plugin)
  const plugin = definition.factory(moduleFor)

  const slots = {
    injected: /** @type {string[]} */ ([]),
    registered: /** @type {object[]} */ ([]),
    inject(/** @type {string} */ name, /** @type {Function} */ factory) {
      slots.injected.push(name)
      return factory()
    },
    register(/** @type {object} */ options) { slots.registered.push(options); return () => {} },
  }
  /** @type {Function[]} */
  const cleanups = []
  plugin.apply({
    effect(/** @type {Function} */ fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return { dispose() {} } },
    slots,
    settingsScope: { bind: () => ({ subscribe() {}, getSnapshot: () => ({ status: 'unavailable', writable: false, value: {}, user: {}, base: {} }) }) },
  })
  await settle()
  return {
    dom,
    calls,
    slots,
    cleanups,
    plugin,
    /** 等异步取数落定并重渲染（测试里那些「点一下 → 回显」的步骤用它推进）。
     *  一轮 = 让出事件循环 ＋ 跑排队的 effect/setState；多跑几轮直到没有新排队项。 */
    render: async () => {
      for (let round = 0; round < 4; round += 1) {
        flush()
        await settle()
        if (hooks.pendingSets.length === 0 && hooks.queuedEffects.length === 0) break
      }
      flush()
    },
    restore() {
      globalThis.fetch = originalFetch
      ;/** @type {any} */ (globalThis).window = originalWindow
      ;/** @type {any} */ (globalThis).document = originalDocument
    },
    id: (/** @type {string} */ value) => dom.document.getElementById(value),
  }
}
