// SPDX-License-Identifier: Apache-2.0
// client/client.js — yammory_system 浏览器半侧（零构建 vanilla，单模块）。
//
// host 端 dsh.client 扫描把本文件作为 classic script 注入 __DSH_BOOT__ 图，
// 执行时经 window.__ModuleLoader__.load 注册唯一 factory（id = 插件名，与
// 宿主 graph row 一致；同文件多个 load 会产生永远不被物化的孤儿 factory）。
// apply 挂载四块表面：侧栏底部入口（官方 sidebar.footer.action 槽）＋ 浮层抽屉面板
// ＋ 会话标题栏的记忆开关 ＋ 宿主设置弹窗的一级设置项。入口的槽位注册失败时回落成
// 右下角悬浮按钮（降级路径），两条路径共用同一套显隐与语言开关。
// 面板只读：条目浏览/搜索/预算条/审计尾/可观测三数，全部走本插件自注册的
// /api/memento/* JSON 路由（只走公开 API）。写与审批在 DSH 内置审批 UI 完成，
// 面板不产生任何模型可见内容、不做任何审批决策。唯一的非只读动作是「整理全库」
// 按钮（收边 §2）：它只登记一条待整理标记，不调模型、不改任何条目——整理本身
// 仍由模型在会话内显式跑（审计红线）。
// 面板文案随 Config.language（en/zh）切换，语言来自 entries 路由响应。
// 设置页经 ctx.settingsScope 读/写用户层（settings.yaml），暂存—保存语义
// 与宿主内置卡片一致；factory 的 require 由宿主模块系统提供（react 为平台
// 内置模块）。

;(function () {
  'use strict'
  if (typeof window === 'undefined' || !window.__ModuleLoader__ || !window.__ModuleLoader__.load) return
  window.__ModuleLoader__.load({
    id: 'yammory_system',
    factory: function (require) {
      const react = require('react')
      /** createElement 简写（宿主平台内置 react，无需构建期 JSX 编译）。 */
      const jsx = react.createElement

const PANEL_ID = 'yammory_system-panel'

/** 本页浮层根节点引用（设置页 panel.enabled 开关即时切换用）。 */
let panelOpenButton = null

/**
 * 降级路径标记：侧栏入口没能落座时为 true（宿主没声明那个槽、或注册同步抛错）。
 * 悬浮按钮只在降级路径存在（主路径由侧栏入口承担），这道闸由 `bootPanel`（挂不挂）
 * 与 `setPanelButtonVisible`（掀不掀）两处一起看守；入口一旦落座，
 * `retireFloatingSeat` 就地把它关掉。
 */
let floatingSeat = false

/**
 * 设置页保存 panel.enabled 后的即时生效面：显隐入口，并切换旧悬浮根节点。
 * 入口显隐走模块级开关（侧栏与悬浮两条路径都认它）；悬浮根节点只在降级路径存在，
 * 主路径那次重建请求会被这里的前置闸挡下，不会冒出悬浮按钮。
 */
function setPanelButtonVisible(visible) {
  setEntryEnabled(visible === true)
  if (!floatingSeat) return
  if (panelOpenButton === null) panelOpenButton = document.getElementById(PANEL_ID)
  if (panelOpenButton !== null) {
    panelOpenButton.style.display = visible ? '' : 'none'
  } else if (visible) {
    void bootPanel({ onToggle: () => { drawerToggle.current() } })
  }
}

/**
 * 入口在侧栏落座后退役悬浮路径：关掉 `floatingSeat` 闸并隐藏本代已挂上的旧根节点。
 * 只认 `panelOpenButton`（本代 `installPanel` 自己记下的那一个），不去 `getElementById`
 * 找可能残留的上一代节点：那不是本代的东西，藏错了等于把别人手上的入口掐掉。
 * 不卸载 React 根（`setPanelButtonVisible` 的前置闸已经保证它不会再被掀开）。
 */
function retireFloatingSeat() {
  floatingSeat = false
  if (panelOpenButton !== null) panelOpenButton.style.display = 'none'
}

/** 面板文案（en 源文 / zh 译文；语言来自 /api/memento/entries 响应的 language 字段，缺省 en）。 */
const STRINGS = {
  en: {
    open: 'Memory',
    title: 'yammory_system memory',
    refresh: 'Refresh',
    close: 'Close',
    filter: 'Filter entries by text…',
    empty: 'Memory is empty. Write with the memory tool (approval happens in the built-in approval UI).',
    emptyFiltered: 'No entry matches the filter.',
    truncated: (shown, total) => `Showing the first ${shown} of ${total} entries — narrow the filter to see more.`,
    groupCount: (n) => `(${n})`,
    count: (shown, total) => (shown === total ? `${total} entries` : `${shown} of ${total} entries match the filter`),
    budgets: 'Warning-line usage',
    budgetOver: 'over the line',
    budgetHint: (used, limit) => `${used} of ${limit} characters — the line only warns; writes are never refused.`,
    audit: 'Recent audit',
    loading: 'Loading…',
    auditEmpty: 'Audit is empty',
    proposals: 'Pending proposals',
    proposalsEmpty: 'No pending proposals (generated after session compaction; decide via /memory proposals approve|dismiss)',
    stats: 'The three numbers',
    statsEmpty: 'The stats route returned nothing.',
    statsFailed: (message) => `Numbers unavailable: ${message}`,
    tidyRequest: 'Tidy the whole library',
    tidyHint: 'Queues one marker: the next session is asked to run the tidy — nothing is merged from here.',
    tidyQueued: 'Queued. The next session will ask the model to tidy the whole library.',
    tidyAlreadyQueued: 'Already queued — no duplicate marker.',
    tidyBusy: 'Queueing…',
    tidyFailed: (message) => `Not queued: ${message}`,
    tabMemory: 'Memory',
    tabExperience: 'Experience',
    treeUnfiled: 'Unfiled',
    topicsUnfiled: 'Untagged',
    levels: 'Knowledge levels',
    levelsEmpty: 'No domain scored yet (write with the memory_profile tool).',
    levelUnscored: 'not scored',
    emptyExperience: 'No experience yet. Lessons about doing the work belong to the agent track — see the yammory-experience skill.',
    loadFailed: (message) => `Load failed: ${message} (panel is read-only; make sure the Web profile has yammory_system loaded)`,
  },
  zh: {
    open: '记忆',
    title: 'yammory_system 记忆',
    refresh: '刷新',
    close: '关闭',
    filter: '按文本过滤条目…',
    empty: '记忆为空。写操作请用 memory 工具（审批在 DSH 内置审批 UI 完成）。',
    emptyFiltered: '没有条目匹配当前过滤。',
    truncated: (shown, total) => `仅显示前 ${shown} 条，共 ${total} 条——用过滤框缩小范围。`,
    groupCount: (n) => `（${n} 条）`,
    count: (shown, total) => (shown === total ? `共 ${total} 条` : `匹配 ${shown} / ${total} 条`),
    budgets: '预警线用量',
    budgetOver: '已越线',
    budgetHint: (used, limit) => `已用 ${used} 字符 / 预警线 ${limit} 字符——越线只提示，不拦写。`,
    audit: '最近审计',
    loading: '加载中…',
    auditEmpty: '审计为空',
    proposals: '待审批提案',
    proposalsEmpty: '暂无待审批提案（会话压缩后自动生成；用 /memory proposals approve|dismiss 处理）',
    stats: '可观测三数',
    statsEmpty: 'stats 路由没有返回内容。',
    statsFailed: (message) => `三数不可用：${message}`,
    tidyRequest: '整理全库',
    tidyHint: '只登记一条待整理标记：下次会话会请模型跑整理——这里不会合并任何条目。',
    tidyQueued: '已登记。下次会话会请模型整理全库。',
    tidyAlreadyQueued: '已在队列里了，不重复登记。',
    tidyBusy: '登记中…',
    tidyFailed: (message) => `未登记：${message}`,
    tabMemory: '记忆',
    tabExperience: '经验',
    treeUnfiled: '未分类',
    topicsUnfiled: '无话题',
    levels: '知识水位',
    levelsEmpty: '还没有领域打过分（用 memory_profile 工具写入）。',
    levelUnscored: '未打分',
    emptyExperience: '还没有经验条目。干活的教训归 agent 轨——见 yammory-experience skill。',
    loadFailed: (message) => `加载失败：${message}（面板只读；请确认 Web profile 已装载 yammory_system）`,
  },
}

/**
 * 会话开关钮文案（en 源文 / zh 译文；语言取 /api/memento/session 响应的 language）。
 * 与 COMAND_TEXT 的命令面文案同口径：开关关掉 = 不注入、不召回、不写入、不观察。
 */
const SWITCH_STRINGS = {
  en: {
    title: 'Memory switch for this session',
    on: 'Memory on',
    off: 'Memory off',
    loading: 'Memory …',
    unavailable: 'Memory n/a',
  },
  zh: {
    title: '本会话的记忆开关',
    on: '记忆已开',
    off: '记忆已关',
    loading: '记忆 …',
    unavailable: '记忆不可用',
  },
}

/**
 * 启动探测：panel.enabled=false 时入口按钮不渲染（设置面板可随时改回）；
 * 探测失败按开启处理，行为与未引入开关前的版本一致。
 * @returns {Promise<{enabled: boolean, language: string}>}。
 */
async function probePanelState() {
  try {
    const response = await fetch('/api/memento/entries?limit=1')
    if (response.ok) {
      const data = await response.json()
      if (data.error === undefined) {
        return { enabled: data.panel?.enabled !== false, language: data.language ?? 'en' }
      }
    }
  } catch {
    // 探测失败：保持默认开启。
  }
  return { enabled: true, language: 'en' }
}

/**
 * 启动探测：语言与显隐落到模块级开关（侧栏入口的文案与显隐都靠它，主路径也要跑）；
 * 悬浮按钮只属于降级路径（`floatingSeat`），主路径探测完即返回，不挂右下角按钮。
 * @param {{ onToggle: () => void }} hooks - 入口按钮的开合回调（只有降级路径用得上）。
 */
async function bootPanel(hooks) {
  const state = await probePanelState()
  entryLanguage = state.language
  entryEnabled = state.enabled
  // 语言与显隐都要等探测返回：已挂载的入口得跟着重渲染，否则先挂上的那一枚会把标签钉死在 en。
  publishEntry()
  if (!state.enabled || !floatingSeat) return
  installPanel({ ...state, onToggle: hooks.onToggle })
}

/** 平台内置模块（种子表）：官方原语与 react-dom/client 只 require 一次。 */
let uiPrimitives = null
let reactDomClient = null

/** 取官方控件库（种子表模块；拿不到即响亮失败，绝不静默降级成自造控件）。 */
function getPrimitives() {
  if (uiPrimitives === null) uiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')
  return uiPrimitives
}

/** 取 react-dom/client（同种子表）。 */
function getReactDomClient() {
  if (reactDomClient === null) reactDomClient = require('react-dom/client')
  return reactDomClient
}

/** 抽屉的关闭出口（apply 注入；抽屉自身不持有开合状态）。 */
const drawerClose = { current: () => {} }

/** 面板槽挂载点：抽屉渲染进宿主给的那块容器（官方 shell.overlay 条目）。 */
let drawerHost = null

/** shell.overlay 条目：只交出一块容器，抽屉本体按需渲染进去。 */
function DrawerHost() {
  const ref = react.useRef(null)
  react.useEffect(() => {
    drawerHost = ref.current
    return () => { drawerHost = null }
  }, [])
  return jsx('div', { ref, 'data-plugin': 'yammory_system' })
}

/**
 * 抽屉挂载：渲染进官方 `shell.overlay` 给的容器；宿主未声明该槽时退回自建 fixed 层。
 *
 * 挂上之后，本插件不再需要「量 dsh-tidewatch 徽章高度、把按钮抬到它之上」那套让位逻辑：
 * 浮层条目由宿主自己排布，插件间唯一的硬耦合随之解除。
 * @returns {() => void} 卸载函数（卸载 React 根；官方槽容器归宿主，不自删）。
 */
function mountDrawer() {
  const el = document.createElement('div')
  ;(drawerHost ?? document.body).appendChild(el)
  const root = getReactDomClient().createRoot(el)
  root.render(jsx(DrawerHolder, null))
  return () => {
    root.unmount()
    el.remove()
  }
}

/** 抽屉的宿主壳：文案表与关闭动作在插槽条目内收口（抽屉本体只管取数与渲染）。 */
function DrawerHolder() {
  const [language, setLanguage] = react.useState('en')
  // 两个回调递给抽屉当 prop，抽屉又拿它们当 effect 依赖：身份必须稳定，
  // 否则每次渲染都会重跑取数 effect（浏览器里就是无限请求）。
  const onLanguage = react.useCallback((code) => { setLanguage(code === 'zh' ? 'zh' : 'en') }, [])
  const onClose = react.useCallback(() => { drawerClose.current() }, [])
  return jsx(Drawer, {
    primitives: getPrimitives(),
    S: STRINGS[language] ?? STRINGS.en,
    onLanguage,
    onClose,
  })
}

// ── 浮层抽屉（React ＋ 官方原语）────────────────────────────────────────────
// 自造 CSS 只剩三段：定位/滚动/排布。控件一律来自
// @deepseek-ai/dsh-client-ui-primitives；色值一律来自 --dsw-* 令牌（亮暗自动跟随）。

/** 面板自造样式（定位、滚动与排布；观感由官方控件与令牌承担）。
 * 降级路径那枚悬浮入口由官方 Button 承担观感，这里只补定位与浮起（elevation 令牌）；
 * 侧栏入口自带按钮语义，几何照抄同槽位、同在侧栏脚区的 dsh-wsl-workspace（W 钮）。 */
const PANEL_LAYOUT_CSS = `
#yammory_system-panel { position: fixed; z-index: 2147483000; font: 13px/1.5 system-ui, "Segoe UI", sans-serif; }
#mem-open { position: fixed; right: 16px; bottom: 56px; z-index: 2147483000; box-shadow: var(--dsw-elevation-prominent); }
/* 侧栏入口（sidebar.footer.action）。两点交代：
   ① 类名刻意避开抽屉条目行的 .mem-entry：两条同权重规则并存时后写的赢，那套几何会盖到
      记忆行上，把抽屉的条目列表压坏。
   ② 侧栏脚区的容器是 display:flex 的**一行**（.footerActions）。同槽位的 dsh-wsl-workspace
      是 28×28 圆图标钮、内容居中、flex: none；若这里摆一条占满整行的 42px 长条，行高会被它
      顶到 42px，而 W 有显式 height: 28px、在 cross 轴上按起点对齐，两个钮便一高一低。
      故这里只跟 W 对齐**竖向几何**（同高 28px、同顶、内容居中），宽度按自己内容取；
      左 4px 间距取自侧栏自身分组习惯（.panelList 的 gap 也是 4px），不是随手数。
   ③ 收起态另说：窄栏的内容盒就是 36px（rail 56px 减两侧 10px 内边距），装不下两个 36px 的钮，
      而宿主的行容器（.footerActions）没有 flex-wrap——并排在窄栏里无解。唯一在自己这侧能做到的
      是把那一行改成竖排，见下面那条 :has() 规则（只在窄栏档生效，宽栏一字不动）。 */
.mem-side-entry { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; margin: 0 0 0 4px; padding: 0 10px; border: none; border-radius: 14px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer; }
.mem-side-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mem-side-entry:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
/* 窄栏档不再留那 4px 左边距：36+4 会超出 36px 内容盒，整枚钮被挤到右边界上。 */
.mem-side-entry--rail { width: 36px; height: 36px; margin: 0; gap: 0; padding: 0; border-radius: 50%; color: var(--dsw-alias-label-primary); }
/* 收起态：把承载本钮的那条行容器改成竖排，两个插件的钮上下排。slot 的包装是 display:contents 的
   [data-slot] 锚点（宿主契约写明它就是动态样式的寻址缝），故按锚点选它所属的行容器，不去猜宿主的
   哈希类名；:has(> .mem-side-entry--rail) 保证只在窄栏档生效。 */
div:has(> [data-slot="sidebar.footer.action"] > .mem-side-entry--rail) { flex-direction: column; align-items: center; gap: 4px; }
.mem-side-entry-label { overflow: hidden; text-overflow: ellipsis; }
.mem-side-entry svg { flex: none; }
#mem-drawer { position: fixed; right: 0; top: 0; bottom: 0; width: 460px; max-width: 92vw; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-left: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-panel); }
.mem-head { padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); display: flex; gap: 6px; align-items: center; }
.mem-head-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-filter { margin: 10px 12px 6px; }
.mem-count { margin: 0 12px 8px; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.mem-body { flex: 1; overflow: auto; padding: 0 12px 12px; }
.mem-group-title { display: flex; align-items: center; margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; color: var(--dsw-alias-label-tertiary); }
.mem-body > div + div > .mem-group-title { margin-top: 18px; }
.mem-rows { display: flex; flex-direction: column; gap: 4px; }
.mem-entry { padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.mem-entry:last-child { border-bottom: none; }
.mem-entry .t { display: block; line-height: 1.55; overflow-wrap: anywhere; }
.mem-entry .m { display: block; margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.mem-text { margin: 4px 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.mem-budget { margin: 0 0 8px; }
.mem-budget-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.mem-budget-name { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-budget-num { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.mem-budget-over .mem-budget-num { color: var(--dsw-alias-state-warn-primary); }
.mem-bar { height: 4px; margin: 5px 0 0; background: var(--dsw-alias-bg-module-platform); border-radius: 2px; overflow: hidden; }
.mem-bar i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.mem-budget-over .mem-bar i { background: var(--dsw-alias-state-warn-primary); }
.mem-tidy { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.mem-tidy-row { display: flex; align-items: center; gap: 8px; }
.mem-tidy-btn { flex: none; white-space: nowrap; }
.mem-tidy-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.mem-batches { gap: 8px; }
.mem-batches-summary { font-size: 12px; }
.mem-batch-list { gap: 0; }
.mem-batch { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
.mem-batch + .mem-batch { border-top: 1px solid var(--dsw-alias-border-l2); }
.mem-batch-details { display: flex; flex-direction: column; gap: 2px; }
/* 两个世界 (记忆／经验)：页签 ＋ 可折叠结构树。 */
.mem-tabs { display: flex; gap: 6px; margin: 0 12px 6px; }
.mem-tree-row { display: flex; align-items: center; gap: 4px; }
.mem-tree-toggle { flex: 1; min-width: 0; justify-content: flex-start; text-align: left; }
.mem-tree-body { display: flex; flex-direction: column; gap: 4px; margin: 0 0 4px 7px; padding-left: 9px; border-left: 1px solid var(--dsw-alias-border-l2); }
.mem-tree-empty { margin: 0 0 4px 16px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.mem-level-cat { margin: 6px 0 2px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.mem-level-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mem-level-row .n { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
`

/**
 * 面板样式表只注入一次，且**必须打上 `data-plugin` 标记**。
 *
 * DSH 的模块装载器有一条规矩：无主的 `<style>` 标签会被认给「正在装载的那个插件」
 * （HMR 记账）；而 HMR 换场时按 `data-plugin` 清场。于是不签名的样式表会被邻居插件的
 * 一次热更新一并删掉——面板的定位与层级随之整套失效，抽屉会塌成一摊正文铺在界面上。
 * `CARD_CSS` 走的是同一条签名的路（见 `apply`）。
 */
let panelStylesInstalled = false
function installPanelStyles() {
  if (panelStylesInstalled || typeof document === 'undefined') return
  panelStylesInstalled = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'yammory_system'
  tag.dataset.pluginCss = 'yammory_system/panel.css'
  tag.textContent = PANEL_LAYOUT_CSS
  document.head.appendChild(tag)
}

/** 抽屉的定位与层级（内联一份作保险：样式表再出意外，面板也不塌；观感仍归官方控件与令牌）。 */
const DRAWER_LAYOUT_STYLE = {
  position: 'fixed', top: 0, right: 0, bottom: 0, width: '460px', maxWidth: '92vw',
  display: 'flex', flexDirection: 'column', zIndex: 2147483000,
}

/** 分组小标题：轨道/层 ＋ 计数（计数用官方 Tag；计数未知时不渲染 Tag）。 */
function groupHeading(primitives, key, count, S) {
  const badge = Number.isInteger(count) ? jsx(primitives.Tag, { tone: 'neutral' }, S.groupCount(count)) : null
  return jsx('div', { className: 'mem-group-title' },
    jsx('span', { style: { marginRight: badge === null ? 0 : 6 } }, key),
    badge)
}

// ── 两个世界：记忆 = user 轨（七面结构树），经验 = agent 轨（话题树）─────
// 面板只按轨道分流，不做内容判别；分家判据与写法归 skills/yammory-experience
// （判据一句话：这条知识该不该每一轮都在场）。

/** 页签与树展开态的模块级记忆：关掉抽屉再打开仍在（不落盘、不进宿主存储）。 */
let panelTab = 'memory'
/** @type {Set<string>} */
const expandedNodes = new Set()

/** 展开态回写模块级记忆（抽屉卸载后仍保留）。 */
function rememberExpansion(next) {
  expandedNodes.clear()
  for (const key of next) expandedNodes.add(key)
}

/** 话题标的保留词：观察/整理/裁决的机器标与分类标、日期标都不算话题。 */
const RESERVED_TOPIC_TAGS = new Set(['observation', 'merged', 'gap', 'A-开发相关', 'B-非开发'])
const DATE_TAG_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 取经验条目的话题：tags 里第一个非保留标（约定写在 skills/yammory-experience）；没有则空串。 */
function topicOf(entry) {
  const tags = Array.isArray(entry.tags) ? entry.tags : []
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.length > 0 && !RESERVED_TOPIC_TAGS.has(tag) && !DATE_TAG_PATTERN.test(tag)) return tag
  }
  return ''
}

/**
 * 记忆轨按七面分桶：面清单由服务端随 entries 响应下发，单一出处仍是
 * `lib/constants.mjs` 的 PROFILE_FACETS。面为空或不在清单内的条目归空串桶，
 * 面板渲染成「未分类」（兜底节点排在最后）。
 */
function groupByFacet(entries, facets) {
  const known = new Set(Array.isArray(facets) ? facets : [])
  const groups = new Map()
  for (const facet of known) groups.set(facet, [])
  for (const entry of entries) {
    const key = typeof entry.facet === 'string' && known.has(entry.facet) ? entry.facet : ''
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [entry])
    else list.push(entry)
  }
  return groups
}

/** 经验轨按话题分桶（无话题的归空串桶，面板渲染成「无话题」）。 */
function groupByTopic(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = topicOf(entry)
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [entry])
    else list.push(entry)
  }
  return groups
}

/** 条目行（两个世界共用同一套渲染：正文 ＋ 来源/agent/时间）。 */
function entryRow(entry) {
  const agentTag = typeof entry.agentKey === 'string' && entry.agentKey.length > 0 ? ` · agent ${entry.agentKey}` : ''
  return jsx('div', { key: entry.id, className: 'mem-entry', title: entry.text },
    jsx('span', { className: 't' }, entry.text),
    jsx('span', { className: 'm' }, `${entry.source}${agentTag} · ${formatTime(entry.createdAt)}`))
}

/** 结构树节点：一行可点的分类名 ＋ 计数；展开才由调用方渲染子树。 */
function treeNode(primitives, nodeKey, label, count, expanded, onToggle, S) {
  return jsx(react.Fragment, { key: nodeKey },
    jsx('div', { className: 'mem-tree-row' },
      jsx(primitives.Button, {
        className: 'mem-tree-toggle',
        variant: 'ghost',
        size: 'sm',
        'aria-expanded': expanded,
        onClick: () => onToggle(nodeKey),
      }, `${expanded ? '▾' : '▸'} ${label}`),
      Number.isInteger(count) ? jsx(primitives.Tag, { tone: 'neutral' }, S.groupCount(count)) : null))
}

/**
 * 知识水位块：八大类 → 31 子领域逐行给 level/tier，未打分的标「未打分」。
 * 类目与子领域清单由服务端随 entries 响应下发，单一出处仍是 `lib/constants.mjs`
 * 的 KNOWLEDGE_CATEGORIES；面板不另存一份清单。
 */
function renderLevels(S, state) {
  const categories = Array.isArray(state.categories) ? state.categories : []
  if (categories.length === 0) return jsx('div', { className: 'mem-tree-empty' }, S.levelsEmpty)
  const byDomain = new Map()
  for (const row of Array.isArray(state.profile) ? state.profile : []) byDomain.set(row.domain, row)
  return categories.map((pair) => {
    const name = Array.isArray(pair) ? String(pair[0]) : ''
    const domains = Array.isArray(pair) && Array.isArray(pair[1]) ? pair[1] : []
    return jsx('div', { key: `lv:${name}` },
      jsx('div', { className: 'mem-level-cat' }, name),
      domains.map((domain) => {
        const row = byDomain.get(domain)
        return jsx('div', { key: `lv:${name}:${domain}`, className: 'mem-level-row' },
          jsx('span', null, domain),
          jsx('span', { className: 'n' }, row === undefined ? S.levelUnscored : `${row.level}/10 · ${row.tier}`))
      }))
  })
}

function renderSnippet(primitives, lines) {
  if (lines === null) return jsx(primitives.Tag, { tone: 'quiet' }, '…')
  return jsx('div', { className: 'mem-rows' }, lines.map((line, index) => jsx('div', { key: index, className: 'mem-text' }, line)))
}

/** 三数（收边 §1）：路由已把三数渲染成文本行，面板照抄。 */
function StatsSection(props) {
  const { primitives, S, state } = props
  const [data, setData] = react.useState(null)
  react.useEffect(() => {
    let alive = true
    if (state.fresh) setData(null)
    void fetch('/api/memento/stats')
      .then((res) => res.json())
      .then((payload) => { if (alive) setData(payload === null || typeof payload !== 'object' ? {} : payload) })
      .catch((error) => { if (alive) setData({ error: String(error && error.message ? error.message : error) }) })
    return () => { alive = false }
  }, [S, state])
  let lines = []
  if (data !== null) {
    if (data.error !== undefined) lines = [S.statsFailed(String(data.error))]
    else if (!Array.isArray(data.lines) || data.lines.length === 0) lines = [S.statsEmpty]
    else lines = data.lines.map(String)
  }
  return renderSnippet(primitives, data === null ? null : lines)
}

/** 最近审计：加载中 → null（Tag …）；失败与空一律「审计为空」（照旧）。 */
function AuditSection(props) {
  const { primitives, S, state } = props
  const [rows, setRows] = react.useState(null)
  react.useEffect(() => {
    let alive = true
    if (state.fresh) setRows(null)
    void fetch('/api/memento/audit?limit=20')
      .then((res) => res.json())
      .then((data) => { if (alive) setRows(Array.isArray(data.rows) ? data.rows : []) })
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [S, state])
  if (rows === null) return renderSnippet(primitives, null)
  if (rows.length === 0) return jsx('div', { className: 'mem-text' }, S.auditEmpty)
  return renderSnippet(primitives, rows.map((row) => {
    const where = row.track ? ` ${row.track}/${row.scope}` : ''
    return `${formatTime(row.ts)} ${row.action}${where} · ${row.outcome ?? ''} · ${row.source ?? ''}`
  }))
}

/**
 * 自动整理留痕（F8 批次面）：摘要、明细行与按钮文案都由路由渲染好（lib/strings.mjs 单一
 * 出处，与命令面同源），面板只负责展开与转发撤回。没有批次记录时整块不渲染——不留空壳；
 * 撤回走 /api/memento/batches（与其它面板动作同一条连接栅栏），成功后重新拉一次。
 */
function BatchesSection(props) {
  const { primitives, S, state } = props
  const [data, setData] = react.useState(null)
  const [open, setOpen] = react.useState(false)
  const [busyId, setBusyId] = react.useState(null)
  const [note, setNote] = react.useState(null)
  const reload = react.useCallback(() => {
    let alive = true
    if (state.fresh) setData(null)
    void fetch('/api/memento/batches')
      .then((res) => res.json())
      .then((payload) => { if (alive) setData(payload === null || typeof payload !== 'object' ? {} : payload) })
      .catch((error) => { if (alive) setData({ error: String(error && error.message ? error.message : error) }) })
    return () => { alive = false }
  }, [state])
  react.useEffect(reload, [reload, S])
  if (data === null) return null
  const batches = Array.isArray(data.batches) ? data.batches : []
  if (batches.length === 0) return null
  const rollback = async (/** @type {string} */ batchId) => {
    setBusyId(batchId)
    setNote(null)
    try {
      const response = await fetch('/api/memento/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchId }),
      })
      const payload = await response.json()
      if (!response.ok || payload.error !== undefined) throw new Error(payload.error === undefined ? `batches ${response.status}` : payload.error)
      setNote(String(payload.note ?? ''))
      reload()
    } catch (error) {
      setNote(String(error && error.message ? error.message : error))
    } finally {
      setBusyId(null)
    }
  }
  return jsx('div', { className: 'mem-tidy mem-batches' },
    jsx('div', { className: 'mem-tidy-row' },
      jsx('b', { className: 'mem-batches-summary' }, String(data.summary ?? '')),
      jsx(primitives.Button, {
        className: 'mem-batch-toggle',
        variant: 'ghost',
        size: 'sm',
        onClick: () => setOpen(!open),
      }, open ? String(data.collapseLabel ?? '') : String(data.expandLabel ?? ''))),
    open
      ? jsx('div', { className: 'mem-rows mem-batch-list' }, batches.map((batch) => jsx('div', { key: String(batch.batchId), className: 'mem-batch' },
          jsx('div', { className: 'mem-batch-details' }, (Array.isArray(batch.details) ? batch.details : []).map((line, index) => jsx('div', { key: index, className: 'mem-text' }, String(line)))),
          jsx(primitives.Button, {
            className: 'mem-batch-rollback',
            variant: 'outline',
            size: 'sm',
            disabled: busyId !== null || batch.rolledBack === true,
            onClick: () => { void rollback(String(batch.batchId)) },
          }, batch.rolledBack === true ? String(batch.rolledBackLabel ?? '') : String(batch.rollbackLabel ?? '')))))
      : null,
    note === null ? null : jsx('p', { className: 'mem-tidy-note mem-batch-note' }, note))
}

/** 待审批提案：加载中 → null；失败与空一律「暂无提案」（照旧）。 */
function ProposalsSection(props) {
  const { primitives, S, state } = props
  const [proposals, setProposals] = react.useState(null)
  react.useEffect(() => {
    let alive = true
    if (state.fresh) setProposals(null)
    void fetch('/api/memento/proposals')
      .then((res) => res.json())
      .then((data) => { if (alive) setProposals(Array.isArray(data.proposals) ? data.proposals : []) })
      .catch(() => { if (alive) setProposals([]) })
    return () => { alive = false }
  }, [S, state])
  if (proposals === null) return renderSnippet(primitives, null)
  if (proposals.length === 0) return jsx('div', { className: 'mem-text' }, S.proposalsEmpty)
  return renderSnippet(primitives, proposals.map((proposal) => {
    const text = proposal.text.length > 160 ? `${proposal.text.slice(0, 160)}…` : proposal.text
    return `[${proposal.id}] ${proposal.track}/${proposal.scope} · ${text}`
  }))
}

/** 「整理全库」按钮 ＋ 状态说明（收边 §2 的同一套行为，改成 React 状态驱动）。 */
function TidyRow(props) {
  const { primitives, S, onLanguage } = props
  const [busy, setBusy] = react.useState(false)
  const [pending, setPending] = react.useState(null)
  const [note, setNote] = react.useState(null)
  const [alive, setAlive] = react.useState(true)
  react.useEffect(() => () => { setAlive(false) }, [])
  react.useEffect(() => {
    void fetch('/api/memento/tidy-request')
      .then((res) => res.json())
      .then((data) => { if (data.error === undefined) setPending(data.pending ?? null) })
      .catch(() => {})
  }, [])
  const request = async () => {
    if (busy) return
    setBusy(true)
    setNote(S.tidyBusy)
    let failed = null
    try {
      const response = await fetch('/api/memento/tidy-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const data = await response.json()
      if (!response.ok || data.error !== undefined) throw new Error(data.error === undefined ? `tidy-request ${response.status}` : data.error)
      onLanguage(data.language)
      setPending(data.pending ?? null)
      setNote(data.created === true ? S.tidyQueued : S.tidyAlreadyQueued)
    } catch (error) {
      failed = S.tidyFailed(String(error && error.message ? error.message : error))
    } finally {
      if (alive) {
        setBusy(false)
        if (failed !== null) setNote(failed)
      }
    }
  }
  return jsx('div', { className: 'mem-tidy' },
    jsx('div', { className: 'mem-tidy-row' },
      jsx(primitives.Button, { className: 'mem-tidy-btn', variant: 'outline', size: 'sm', disabled: busy, onClick: () => { void request() } }, S.tidyRequest)),
    jsx('p', { className: 'mem-tidy-note' }, note ?? (pending === null ? S.tidyHint : S.tidyAlreadyQueued)))
}

/** 抽屉正文：两个世界（记忆＝七面结构树／经验＝话题树）＋ 预算条 ＋ 审计尾 ＋ 提案区 ＋ 三数行。 */
function PanelContent(props) {
  const { primitives, rootRef, S, state, onLanguage, onRefresh, onFilter } = props
  const [tab, setTab] = react.useState(panelTab)
  const [expanded, setExpanded] = react.useState(() => new Set(expandedNodes))
  const toggleNode = (key) => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    rememberExpansion(next)
    setExpanded(next)
  }
  const switchTab = (next) => { panelTab = next; setTab(next) }
  // 计数行与正文共用同一份过滤结果，故提前算一次（上限为面板条目页上限，成本可忽略）。
  const filtering = state.filter.trim() !== ''
  const visible = state.entries.filter((entry) => entry.text.toLowerCase().includes(state.filter.toLowerCase()))
  const onTab = (entry) => (tab === 'experience' ? entry.track !== 'user' : entry.track === 'user')
  const shown = visible.filter(onTab)
  const tabTotal = state.entries.filter(onTab).length
  const countLine = state.fresh === true && state.error === null ? S.count(shown.length, tabTotal) : null
  let body
  if (state.error !== null) {
    body = jsx('div', { className: 'mem-text' }, S.loadFailed(state.error))
  } else if (state.fresh === false) {
    body = jsx('div', { className: 'mem-text' }, S.loading)
  } else {
    const children = []
    if (state.truncated) children.push(jsx('div', { key: 'truncated', className: 'mem-text' }, S.truncated(state.entries.length, state.total)))
    if (shown.length === 0) {
      children.push(jsx('div', { key: 'empty', className: 'mem-text' },
        filtering ? S.emptyFiltered : (tab === 'experience' ? S.emptyExperience : S.empty)))
    } else if (tab === 'experience') {
      // 经验世界：按话题分桶；话题标 = tags 里第一个非保留标（约定见 skills/yammory-experience）。
      for (const [topic, list] of groupByTopic(shown)) {
        const key = `topic:${topic}`
        const open = filtering || expanded.has(key)
        children.push(treeNode(primitives, key, topic === '' ? S.topicsUnfiled : topic, list.length, open, toggleNode, S))
        if (open) children.push(jsx('div', { key: `${key}:body`, className: 'mem-tree-body' }, list.map(entryRow)))
      }
    } else {
      // 记忆世界：七面固定板块按序排列，空面也显示（把架构摆上前端），未分类垫底。
      for (const [facet, list] of groupByFacet(shown, state.facets)) {
        if (facet === '' && list.length === 0) continue
        const key = `facet:${facet}`
        const open = filtering || expanded.has(key)
        children.push(treeNode(primitives, key, facet === '' ? S.treeUnfiled : facet, list.length, open, toggleNode, S))
        if (open) {
          children.push(list.length === 0
            ? jsx('div', { key: `${key}:body`, className: 'mem-tree-empty' }, '—')
            : jsx('div', { key: `${key}:body`, className: 'mem-tree-body' }, list.map(entryRow)))
        }
      }
      // 知识水位：单独一块（不是条目），展开态与条目树分开记。
      const levelsOpen = expanded.has('levels')
      const scored = Array.isArray(state.profile) ? state.profile.length : 0
      children.push(treeNode(primitives, 'levels', S.levels, scored, levelsOpen, toggleNode, S))
      if (levelsOpen) children.push(jsx('div', { key: 'levels:body', className: 'mem-tree-body' }, renderLevels(S, state)))
    }
    if (state.budgets.length > 0) {
      children.push(jsx('div', { key: 'budgets' }, groupHeading(primitives, S.budgets, state.budgets.length, S),
        jsx('div', { className: 'mem-rows' }, state.budgets.map((row, index) => {
          const over = row.limit > 0 && row.used > row.limit
          const pct = row.limit > 0 ? Math.min(100, Math.round((row.used / row.limit) * 100)) : 0
          return jsx('div', { key: index, className: `mem-budget${over ? ' mem-budget-over' : ''}`, title: S.budgetHint(row.used, row.limit) },
            jsx('div', { className: 'mem-budget-head' },
              jsx('span', { className: 'mem-budget-name' }, `${row.track}/${row.scope}`),
              jsx('span', { className: 'mem-budget-num' }, `${row.used} / ${row.limit}`),
              over ? jsx(primitives.Tag, { tone: 'warning' }, S.budgetOver) : null),
            jsx('div', { className: 'mem-bar' }, jsx('i', { style: { width: `${pct}%` } })))
        }))))
      children.push(jsx('div', { key: 'audit' }, groupHeading(primitives, S.audit, '', S), jsx(AuditSection, { primitives, S, state })))
      children.push(jsx('div', { key: 'proposals' }, groupHeading(primitives, S.proposals, '', S), jsx(ProposalsSection, { primitives, S, state })))
      children.push(jsx('div', { key: 'stats' }, groupHeading(primitives, S.stats, '', S), jsx(StatsSection, { primitives, S, state })))
    }
    body = jsx(react.Fragment, null, children)
  }
  return jsx(react.Fragment, null,
    jsx('div', { className: 'mem-head' },
      jsx('b', { className: 'mem-head-title' }, S.title),
      jsx(primitives.StateDot, { state: state.error !== null ? 'error' : (state.busy ? 'ongoing' : (state.fresh ? 'done' : 'idle')) }),
      jsx(primitives.Button, { variant: 'ghost', size: 'sm', onClick: onRefresh }, S.refresh),
      withTooltip(primitives, S.close,
        jsx(primitives.Button, { variant: 'ghost', size: 'sm', 'aria-label': S.close, onClick: () => onLanguage(null) }, '✕'))),
    jsx(primitives.Input, {
      className: 'mem-filter',
      placeholder: S.filter,
      defaultValue: state.filter,
      onInput: (event) => onFilter(event.target.value),
    }),
    jsx('div', { className: 'mem-tabs' },
      jsx(primitives.Pill, { className: 'mem-tab', active: tab !== 'experience', onClick: () => switchTab('memory') },
        `${S.tabMemory} (${state.entries.filter((entry) => entry.track === 'user').length})`),
      jsx(primitives.Pill, { className: 'mem-tab', active: tab === 'experience', onClick: () => switchTab('experience') },
        `${S.tabExperience} (${state.entries.filter((entry) => entry.track !== 'user').length})`)),
    countLine === null ? null : jsx('div', { className: 'mem-count' }, countLine),
    jsx('div', { ref: rootRef, className: 'mem-body' }, body),
    jsx(BatchesSection, { primitives, S, state }),
    jsx(TidyRow, { primitives, S, onLanguage }))
}

// ── 入口：侧栏底部槽位（主路径）＋ 右下角悬浮按钮（降级路径）────────────────
// 侧栏入口占官方 `sidebar.footer.action`，与「设置」同处侧栏脚区，这是主路径：
// 它不再与别的插件（如 dsh-tidewatch）争右下角那一块地方。槽位不可用时才回落到
// 原来那枚右下角悬浮按钮，两条路径的显隐与语言共用下面这套模块级小开关。

/** 面板入口的显隐与语言：模块级小开关（设置页 panel.enabled 与启动探测的即时生效面）。 */
let entryEnabled = true
let entryLanguage = 'en'
const entryListeners = new Set()

/** 通知已挂载的入口重渲染（显隐或语言变化后调用）。 */
function publishEntry() {
  for (const fn of entryListeners) fn()
}

/** 设置页保存后回写：切换入口显隐，并通知已挂载的入口组件重渲染。 */
function setEntryEnabled(next) {
  if (entryEnabled === next) return
  entryEnabled = next
  publishEntry()
}

/**
 * 订阅入口开关。语言与显隐两类变化都经 `publishEntry` 广播，故用版本号当重渲染信号：
 * 直接 set 一个没变的值时 React 会跳过渲染，语言就落不到已挂载的那一枚入口上。
 */
function useEntryEnabled() {
  const [, bump] = react.useState(0)
  react.useEffect(() => {
    const notify = () => { bump((n) => n + 1) }
    entryListeners.add(notify)
    return () => { entryListeners.delete(notify) }
  }, [])
  return entryEnabled
}

/** 抽屉开合出口（apply 注入；入口组件不持有状态）。 */
const drawerToggle = { current: () => {} }

/**
 * 侧栏底部入口（`sidebar.footer.action` 条目）：与「设置」同处侧栏脚区。
 * 竖向几何与同槽位的 dsh-wsl-workspace（W 钮）对齐：同高 **28px**、同顶、内容居中；
 * 宽度自己按内容取——宽栏出「图标 ＋ 文字」（胶囊），窄栏收起为 36×36 圆图标钮。
 * 两者只共用「高」与「对齐」，不互相拉伸，故不再一高一低。
 * `panel.enabled === false` 时整条不渲染（设置页开回来即出现）。
 */
function MemoryEntryButton(props) {
  const wide = props?.wide !== false
  const enabled = useEntryEnabled()
  if (!enabled) return null
  const S = STRINGS[entryLanguage] ?? STRINGS.en
  return jsx('button', {
    type: 'button',
    id: 'mem-entry',
    className: wide ? 'mem-side-entry' : 'mem-side-entry mem-side-entry--rail',
    title: S.open,
    'aria-label': S.open,
    onClick: () => { drawerToggle.current() },
  },
  jsx(getPrimitives().IconDatabaseOutline16, { size: 16 }),
  wide ? jsx('span', { className: 'mem-side-entry-label' }, S.open) : null)
}

/** 降级路径的入口（官方 Button，右下角悬浮）；只在侧栏槽位注册失败时挂载。 */
function PanelButton(props) {
  const { primitives, S, onToggle } = props
  // 定位与层级内联一份（样式的第二层保险；控件观感仍由官方 Button 承担）。
  const style = { position: 'fixed', right: '16px', bottom: '56px', zIndex: 2147483000 }
  return jsx(primitives.Button, { variant: 'outline', id: 'mem-open', style, onClick: onToggle }, S.open)
}

/** 抽屉本体：打开时取一轮数据，之后每次「刷新」再取一轮（行为照旧）。 */
function Drawer(props) {
  const { primitives, S, onLanguage, onClose } = props
  const [counter, setCounter] = react.useState(0)
  const [state, setState] = react.useState({ fresh: false, busy: false, error: null, entries: [], total: 0, truncated: false, budgets: [], facets: [], categories: [], profile: [], filter: '' })
  const bodyRef = react.useRef(null)
  react.useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setState((prev) => ({ ...prev, busy: true }))
    void (async () => {
      try {
        const response = await fetch('/api/memento/entries?limit=200', { signal: controller.signal })
        if (!response.ok) throw new Error(`entries ${response.status}`)
        const data = await response.json()
        if (data.error !== undefined) throw new Error(data.error)
        if (!alive) return
        onLanguage(data.language)
        setState((prev) => ({
          fresh: true,
          busy: false,
          error: null,
          entries: Array.isArray(data.entries) ? data.entries : [],
          total: Number.isInteger(data.total) ? data.total : (Array.isArray(data.entries) ? data.entries.length : 0),
          truncated: data.truncated === true,
          budgets: Array.isArray(data.budgets) ? data.budgets : [],
          facets: Array.isArray(data.facets) ? data.facets : [],
          categories: Array.isArray(data.categories) ? data.categories : [],
          profile: Array.isArray(data.profile) ? data.profile : [],
          filter: prev.filter,
        }))
      } catch (error) {
        if (!alive) return
        setState((prev) => ({ ...prev, busy: false, fresh: true, error: String(error && error.message ? error.message : error) }))
      }
    })()
    return () => { alive = false; controller.abort() }
  }, [counter, onLanguage])
  // Esc 关抽屉：面板是 460px 浮层，盖住正文，键盘出口不该缺。
  react.useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  return jsx('div', { id: 'mem-drawer', style: DRAWER_LAYOUT_STYLE },
    jsx(PanelContent, {
      primitives,
      rootRef: bodyRef,
      S,
      state,
      onLanguage: (language) => { if (language === null) onClose() },
      onRefresh: () => setCounter((c) => c + 1),
      onFilter: (text) => setState((prev) => ({ ...prev, filter: text })),
    }))
}

/**
 * 浮层抽屉挂载：入口按钮 ＋ 抽屉共用一个 react-dom/client 根（createRoot）。
 * 面板只读（除「整理全库」只登记标记），所有动作仍走 /api/memento/* 路由。
 */
function installPanel(state) {
  if (document.getElementById(PANEL_ID)) return
  // 样式先落盘并签名（见 installPanelStyles）；再取官方原语，免得 require 抛错时连样式都没落。
  installPanelStyles()
  const primitives = getPrimitives()
  let S = STRINGS[state.language] ?? STRINGS.en

  const root = document.createElement('div')
  root.id = PANEL_ID
  root.setAttribute('style', 'position: fixed; z-index: 2147483000;')
  document.body.appendChild(root)
  // 设置页「显示侧栏的记忆入口」的即时生效面：模块级开关广播 ＋（降级路径下）旧悬浮根节点的显隐。
  panelOpenButton = root

  // 入口按钮的文字只在挂载时定一次（与迁移前一致：抽屉侧换语言不回写按钮）。
  const overlay = getReactDomClient().createRoot(root)
  overlay.render(jsx(PanelButton, { primitives, S, onToggle: state.onToggle }))
}

/** 时间戳 → 本地时间串（审计行、条目与提案元信息共用同一口径）。 */
function formatTime(value) {
  return value === undefined || value === null ? '' : new Date(value).toLocaleString()
}

/** 官方 Tooltip 包装（悬停提示与 title 同文案；disabled 时不弹泡）。 */
function withTooltip(primitives, label, element, disabled) {
  return jsx(primitives.Tooltip, { label, side: 'bottom', disabled: disabled === true }, element)
}

// ── 宿主设置页（settings.section 一级项，id = yammory-system）──────────────
      /** 卡片文案（en 源文 / zh 译文；语言跟随 namespace value.language，保存后即时切换）。 */
      const CARD_STRINGS = {
        en: {
          title: 'yammory_system memory',
          description: 'Approval-gated cross-session memory. Writes, snapshot wording, the sidebar entry and the panel follow these values.',
          sectionPermissions: 'Write approval policy',
          sectionPanel: 'Sidebar entry',
          sectionLanguage: 'Language',
          sectionBudgets: 'Warning lines (per track/layer)',
          sectionLimits: 'Query & command limits',
          sectionRecall: 'Recall defaults',
          sectionRetrieval: 'Vector recall (spec 3.3 · layer B)',
          sectionWeighting: 'Recall weighting (spec 3.3 · layer B)',
          sectionPanelPage: 'Panel page limits',
          sectionProposals: 'Auto-capture proposals',
          sectionStorage: 'Storage & audit retention',
          sectionAdvanced: 'Advanced (applied after DSH reload)',
          writePolicy: 'Global write policy',
          writePolicies: 'Per-track/scope policies',
          writePoliciesHint: 'One per line: track/scope=policy or source:name=policy. Unknown keys fail validation on save.',
          panelEnabled: 'Show the sidebar memory entry',
          language: 'Language',
          budgetUserGlobal: 'user / user-global',
          budgetUserWorkspace: 'user / workspace',
          budgetAgentGlobal: 'agent / user-global',
          budgetAgentWorkspace: 'agent / workspace',
          maxEntriesPerQuery: 'query default limit',
          commandListLimit: '/memory list|query page limit',
          commandAuditLimit: '/memory audit page limit',
          recallHistoryLimit: 'history sessions per recall',
          recallSnippetCap: 'snippets per session',
          recallSnippetChars: 'snippet characters',
          recallWindowDays: 'history window (days)',
          hintRetrievalVector: 'Only engages when a provider that declares itself semantic is registered; the built-in hash provider is a placeholder, so this switch falls back to keyword recall.',
          choiceAsk: 'Ask',
          choiceAuto: 'Auto',
          choiceOff: 'Off',
          choiceEn: 'English',
          choiceZh: '中文',
          weightHeat: 'heat bonus (0 = off)',
          weightHeatSaturation: 'recalls that saturate heat',
          weightHeatHalfLifeDays: 'heat half-life (days)',
          weightFreshness: 'freshness bonus',
          weightFreshnessHalfLifeDays: 'freshness half-life (days)',
          weightTagDiscount: 'tag-only hit discount',
          panelEntriesLimit: 'entries page limit',
          panelAuditLimit: 'audit page limit',
          proposalsEnabled: 'Generate proposals after compaction',
          proposalsMaxChars: 'proposal max characters',
          proposalsMaxPending: 'max pending proposals',
          dbPath: 'Memory database path',
          dbPathHint: 'Empty = default ($DSH_HOME/dsh-memento/memory.db). Saving reopens the store immediately.',
          snapshotOrder: 'Snapshot section order',
          auditRetentionDays: 'Audit retention (days, 0 = unlimited)',
          retrievalVector: 'Vector recall (when an embedding provider exists)',
          reloadHint: 'Applied after DSH reload',
          helpLabel: 'What this setting does',
          overridden: 'Overridden',
          reset: 'Reset',
          resetField: 'Reset field',
          save: 'Save',
          saving: 'Saving…',
          discard: 'Discard',
          unsaved: 'Unsaved changes',
          saveFailed: 'Save failed — drafts kept for correction.',
          readOnly: 'Read-only (settings service unavailable).',
          invalidNumber: 'Must be a whole number.',
          invalidDecimal: 'Must be a number.',
          invalidPolicy: 'Must be ask, auto or off.',
        },
        zh: {
          title: 'yammory_system 记忆',
          description: '带审批门的跨会话记忆。写入策略、快照文案、侧栏入口与面板跟随这些值。',
          sectionPermissions: '写审批策略',
          sectionPanel: '侧栏入口',
          sectionLanguage: '语言',
          sectionBudgets: '软预警线（每轨道/层）',
          sectionLimits: '查询与命令上限',
          sectionRecall: '召回默认值',
          sectionRetrieval: '向量召回（规格 3.3 · 层 B）',
          sectionWeighting: '召回加权（规格 3.3 · 层 B）',
          sectionPanelPage: '面板页上限',
          sectionProposals: '自动捕捉提案',
          sectionStorage: '存储与审计保留',
          sectionAdvanced: '高级（DSH 重载后生效）',
          writePolicy: '全局写策略',
          writePolicies: '按轨道/层粒度策略',
          writePoliciesHint: '每行一条：track/scope=策略 或 source:name=策略。保存时无法识别的键会被校验拒绝。',
          panelEnabled: '显示侧栏的记忆入口',
          language: '语言',
          budgetUserGlobal: 'user / user-global',
          budgetUserWorkspace: 'user / workspace',
          budgetAgentGlobal: 'agent / user-global',
          budgetAgentWorkspace: 'agent / workspace',
          maxEntriesPerQuery: 'query 默认上限',
          commandListLimit: '/memory list|query 单页上限',
          commandAuditLimit: '/memory audit 单页上限',
          recallHistoryLimit: '每次召回扫描会话数',
          recallSnippetCap: '每会话片段数',
          recallSnippetChars: '片段字符数',
          recallWindowDays: '历史窗口（天）',
          hintRetrievalVector: '只有注册了声明为语义的 embedding provider 时才真正生效；内置是哈希伪嵌入，打开也回落 keyword。',
          choiceAsk: '询问',
          choiceAuto: '自动',
          choiceOff: '拒绝',
          choiceEn: 'English',
          choiceZh: '中文',
          weightHeat: '热度加成（0 = 关闭）',
          weightHeatSaturation: '吃满热度的召回次数',
          weightHeatHalfLifeDays: '热度半衰期（天）',
          weightFreshness: '新旧加成',
          weightFreshnessHalfLifeDays: '新旧半衰期（天）',
          weightTagDiscount: '仅标签命中的折扣',
          panelEntriesLimit: '条目单页上限',
          panelAuditLimit: '审计单页上限',
          proposalsEnabled: '压缩结束后生成提案',
          proposalsMaxChars: '提案最大字符数',
          proposalsMaxPending: '待审批提案上限',
          dbPath: '记忆库路径',
          dbPathHint: '留空 = 默认（$DSH_HOME/dsh-memento/memory.db）。保存后立即重开记忆库。',
          snapshotOrder: '快照段注入顺序',
          auditRetentionDays: '审计保留天数（0 = 不限）',
          retrievalVector: '向量召回（存在 embedding provider 时）',
          reloadHint: 'DSH 重载后生效',
          helpLabel: '这一项是做什么的',
          overridden: '已覆盖',
          reset: '重置',
          resetField: '重置该字段',
          save: '保存',
          saving: '保存中…',
          discard: '放弃修改',
          unsaved: '有未保存修改',
          saveFailed: '保存失败——草稿已保留，可修正后重试。',
          readOnly: '只读（设置服务不可用）。',
          invalidNumber: '必须是整数。',
          invalidDecimal: '必须是数字。',
          invalidPolicy: '必须是 ask、auto 或 off。',
        },
      }

      /** 顶层字段名（保存按顶层聚合：scope.set(topField, 合并值)，不依赖点路径写入面）。 */
      const POLICIES = ['ask', 'auto', 'off']

      /** 简版快照 store（useSyncExternalStore 形状：{getSnapshot, subscribe}+set）。 */
      function createSnapshotStore(initial) {
        let snapshot = initial
        const listeners = new Set()
        return {
          getSnapshot() { return snapshot },
          subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
          set(next) { snapshot = next; for (const fn of listeners) fn() },
        }
      }

      /** 读点路径（'a.b' → obj?.a?.b）。 */
      function pathValue(obj, path) {
        let cursor = obj
        for (const key of path.split('.')) {
          if (cursor === null || typeof cursor !== 'object') return undefined
          cursor = cursor[key]
        }
        return cursor
      }

      /** 判定子字段是否被用户层覆盖（user 层子路径 hasOwn）。 */
      function pathStored(user, path) {
        const keys = path.split('.')
        const last = keys.pop()
        let cursor = user
        for (const key of keys) {
          if (cursor === null || typeof cursor !== 'object') return false
          cursor = cursor[key]
        }
        return cursor !== null && typeof cursor === 'object' && Object.hasOwn(cursor, last)
      }

      /** 深合并（草稿子树 → 当前顶层值；数组与标量直接替换）。 */
      function deepMerge(base, patch) {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
        const out = { ...(base !== null && typeof base === 'object' && !Array.isArray(base) ? base : {}) }
        for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value)
        return out
      }

      /** 子字段规格：path + kind（number/text/bool/choice/policies）+ choice 候选 + key（文案键）。 */
      const FIELD_SPECS = [
        { path: 'writePolicy', kind: 'choice', choices: POLICIES, key: 'writePolicy' },
        { path: 'writePolicies', kind: 'policies', key: 'writePolicies' },
        { path: 'panel.enabled', kind: 'bool', key: 'panelEnabled' },
        { path: 'language', kind: 'choice', choices: ['en', 'zh'], key: 'language' },
        { path: 'budgets.user.userGlobal', kind: 'number', key: 'budgetUserGlobal' },
        { path: 'budgets.user.workspace', kind: 'number', key: 'budgetUserWorkspace' },
        { path: 'budgets.agent.userGlobal', kind: 'number', key: 'budgetAgentGlobal' },
        { path: 'budgets.agent.workspace', kind: 'number', key: 'budgetAgentWorkspace' },
        { path: 'maxEntriesPerQuery', kind: 'number', key: 'maxEntriesPerQuery' },
        { path: 'commandListLimit', kind: 'number', key: 'commandListLimit' },
        { path: 'commandAuditLimit', kind: 'number', key: 'commandAuditLimit' },
        { path: 'recall.historyLimitDefault', kind: 'number', key: 'recallHistoryLimit' },
        { path: 'recall.snippetCap', kind: 'number', key: 'recallSnippetCap' },
        { path: 'recall.snippetChars', kind: 'number', key: 'recallSnippetChars' },
        { path: 'recall.windowDays', kind: 'number', key: 'recallWindowDays' },
        { path: 'recall.weighting.heat', kind: 'decimal', key: 'weightHeat' },
        { path: 'recall.weighting.heatSaturation', kind: 'decimal', key: 'weightHeatSaturation' },
        { path: 'recall.weighting.heatHalfLifeDays', kind: 'decimal', key: 'weightHeatHalfLifeDays' },
        { path: 'recall.weighting.freshness', kind: 'decimal', key: 'weightFreshness' },
        { path: 'recall.weighting.freshnessHalfLifeDays', kind: 'decimal', key: 'weightFreshnessHalfLifeDays' },
        { path: 'recall.weighting.tagDiscount', kind: 'decimal', key: 'weightTagDiscount' },
        { path: 'panelEntriesLimit', kind: 'number', key: 'panelEntriesLimit' },
        { path: 'panelAuditLimit', kind: 'number', key: 'panelAuditLimit' },
        { path: 'proposals.enabled', kind: 'bool', key: 'proposalsEnabled' },
        { path: 'proposals.maxChars', kind: 'number', key: 'proposalsMaxChars' },
        { path: 'proposals.maxPending', kind: 'number', key: 'proposalsMaxPending' },
        { path: 'dbPath', kind: 'text', key: 'dbPath' },
        { path: 'snapshotOrder', kind: 'number', key: 'snapshotOrder' },
        { path: 'auditRetentionDays', kind: 'number', key: 'auditRetentionDays' },
        { path: 'retrieval.vector', kind: 'bool', key: 'retrievalVector' },
      ]
      const SPEC_BY_PATH = new Map(FIELD_SPECS.map((spec) => [spec.path, spec]))
      const RELOAD_PATHS = new Set(['snapshotOrder'])

      /** 选择型字段的候选文案键（缺键回落到原始值）。 */
      const CHOICE_LABELS = {
        'writePolicy:ask': 'choiceAsk',
        'writePolicy:auto': 'choiceAuto',
        'writePolicy:off': 'choiceOff',
        'language:en': 'choiceEn',
        'language:zh': 'choiceZh',
      }

      /** 字段级说明文案（路径 → 文案键）：原先写死在 FieldRow 里的两条分支改成查表。 */
      const FIELD_HINTS = new Map([
        ['writePolicies', 'writePoliciesHint'],
        ['dbPath', 'dbPathHint'],
        ['retrieval.vector', 'hintRetrievalVector'],
      ])

      /** 每个设置项的大白话说明（点问号展开）。与 FIELD_SPECS 同处：两种语言相邻，便于对照维护。 */
      const FIELD_NOTES = new Map([
        ['writePolicy', {
          en: 'Whether a memory write asks first. `ask` prompts every time, `auto` writes straight through (the audit row is still kept), `off` refuses. The model can neither see nor change this value.',
          zh: '模型要把一条记忆写进库里时，先问过您还是直接放行。ask＝每次弹审批；auto＝不弹、直接落库（审计照留）；off＝一律拒绝。这一项模型既看不见也改不了。',
        }],
        ['writePolicies', {
          en: 'Per-bucket overrides for the global policy, one per line: `user/workspace=auto` or `source:<name>=off`. Anything unlisted falls back to the global policy; an unknown key is rejected on save.',
          zh: '给某一类记忆单独定策略，用来覆盖上面的全局值。每行一条：user/workspace=auto 或 source:<来源名>=off。没写到的照旧走全局策略；写错键保存时会被拦下。',
        }],
        ['panel.enabled', {
          en: 'Shows or hides the “Memory” entry at the sidebar foot. Hiding it removes the entry point only; the plugin and this settings card keep working.',
          zh: '侧栏底部那枚「记忆」入口的显隐。关掉只是入口不在，设置页这张卡片照旧，插件本身也照常工作。',
        }],
        ['language', {
          en: 'Language for the panel, snapshot wording and command output. Tool descriptions are fixed when the plugin loads, so they do not follow this.',
          zh: '面板、快照文案与命令输出用哪种语言。工具描述在插件加载时就定下了，改这一项不会动它。',
        }],
        ['budgets.user.userGlobal', {
          en: 'The warning line for this bucket’s character count. Passing it never blocks a write; it only says on the panel, in the snapshot header and in the audit that a tidy is due. Each of the four buckets keeps its own tally.',
          zh: '这一格的字数软线。写满也不拦写，超线只在面板、快照头与审计里提示您该整理了。四个格子各算各的账。',
        }],
        ['budgets.user.workspace', {
          en: 'The warning line for this bucket’s character count. Passing it never blocks a write; it only says on the panel, in the snapshot header and in the audit that a tidy is due. Each of the four buckets keeps its own tally.',
          zh: '这一格的字数软线。写满也不拦写，超线只在面板、快照头与审计里提示您该整理了。四个格子各算各的账。',
        }],
        ['budgets.agent.userGlobal', {
          en: 'The warning line for this bucket’s character count. Passing it never blocks a write; it only says on the panel, in the snapshot header and in the audit that a tidy is due. Each of the four buckets keeps its own tally.',
          zh: '这一格的字数软线。写满也不拦写，超线只在面板、快照头与审计里提示您该整理了。四个格子各算各的账。',
        }],
        ['budgets.agent.workspace', {
          en: 'The warning line for this bucket’s character count. Passing it never blocks a write; it only says on the panel, in the snapshot header and in the audit that a tidy is due. Each of the four buckets keeps its own tally.',
          zh: '这一格的字数软线。写满也不拦写，超线只在面板、快照头与审计里提示您该整理了。四个格子各算各的账。',
        }],
        ['maxEntriesPerQuery', {
          en: 'How many entries `memory_recall` returns by default. An explicit limit overrides it; the provider still clamps at 1000.',
          zh: 'memory_recall 一次默认带回多少条。调用时显式给 limit 可以突破它；Provider 层另有 1000 条的硬钳制。',
        }],
        ['commandListLimit', {
          en: 'How many rows `/memory list` and `/memory query` print at once. Display only; the store is untouched.',
          zh: '/memory list、/memory query 一屏最多渲染多少条。只影响显示，不动库里的东西。',
        }],
        ['commandAuditLimit', {
          en: 'How many audit rows `/memory audit` prints at once.',
          zh: '/memory audit 一屏最多显示多少行审计。',
        }],
        ['recall.historyLimitDefault', {
          en: 'How many recent sessions a recall scans. More sessions find older preferences; they also cost more.',
          zh: '按需召回时，往最近的会话历史里翻几个会话。翻得越多越可能捞到旧偏好，也越慢。',
        }],
        ['recall.snippetCap', {
          en: 'How many candidate snippets each session contributes.',
          zh: '每个会话最多摘几段候选出来。',
        }],
        ['recall.snippetChars', {
          en: 'Characters kept per snippet, so a long message cannot blow up the context.',
          zh: '每段截到多少字符（截断是为了不把上下文撑爆）。',
        }],
        ['recall.windowDays', {
          en: 'Only the last N days are scanned. Older history stays in the store but stops being recalled.',
          zh: '只回看最近多少天的历史。更早的留着，但不再参与召回。',
        }],
        ['retrieval.vector', {
          en: 'The semantic-recall switch. It only engages when a provider that declares itself semantic is registered; the built-in provider is a hash placeholder, so today this switch still falls back to keyword recall.',
          zh: '语义召回开关。只有注册了「声明自己是语义」的嵌入 provider 时才真正生效；内置那个是哈希伪嵌入，所以现在打开也照样回落关键词检索。',
        }],
        ['recall.weighting.heat', {
          en: 'How much being recalled often lifts an entry. Score = relevance × (1 + heat bonus × heat factor). Zero means heat is ignored.',
          zh: '常用的记忆该不该往上浮。最终分数＝相关度 ×（1 ＋ 热度加成 × 热度因子）。设 0 就是不管热度。',
        }],
        ['recall.weighting.heatSaturation', {
          en: 'How many recalls count as fully hot. Past this the bonus stops growing.',
          zh: '被召回多少次算「够热」，到这个数热度加成吃满；再被召回也不会更高。',
        }],
        ['recall.weighting.heatHalfLifeDays', {
          en: 'Heat decays. After this many days without a recall it halves, and halves again after each further stretch. Heat has to be kept up to survive.',
          zh: '热度会失温。这么多天没被召回，热度减半；再过这么久，再减半。所以热度要靠持续被召回维持。',
        }],
        ['recall.weighting.freshness', {
          en: 'How much a freshly written entry lifts. Zero ignores recency.',
          zh: '新写进来的记忆该不该往上浮一点。0 = 完全不看新旧。',
        }],
        ['recall.weighting.freshnessHalfLifeDays', {
          en: 'The freshness bonus halves every this many days. A smaller number means only recent writes stand out.',
          zh: '新旧加成也衰减：过了这么多天，加成减半。天数越小，越只看最近写的。',
        }],
        ['recall.weighting.tagDiscount', {
          en: 'How much a hit that lands only in the tags counts (the body does not mention it). 1 = same as a body hit, 0 = not a hit at all.',
          zh: '检索词只在标签里命中、正文没提到时，算它几成。1 ＝ 与正文命中同权，0 ＝ 完全不算命中。',
        }],
        ['panelEntriesLimit', {
          en: 'How many entries the drawer lists at once; the rest are only counted.',
          zh: '面板抽屉一次最多列出多少条记忆（超出只计数）。',
        }],
        ['panelAuditLimit', {
          en: 'How many rows the drawer’s “Recent audit” section shows by default.',
          zh: '抽屉里「最近审计」默认显示多少行。',
        }],
        ['proposals.enabled', {
          en: 'After a session is compacted, propose what might be worth remembering. Turning it off stops new proposals.',
          zh: '会话被压缩之后，顺手生成「这条要不要写进记忆」的提案让人过目。关掉就不再攒提案。',
        }],
        ['proposals.maxChars', {
          en: 'Character cap for one proposal; longer text is shortened.',
          zh: '单条提案最多多少字符，超了会被截。',
        }],
        ['proposals.maxPending', {
          en: 'How many undecided proposals are kept. Once full, no new ones are generated until some are decided.',
          zh: '最多攒几条没处理的提案。攒满了就不再生成新的，直到您处理掉一些。',
        }],
        ['dbPath', {
          en: 'Where the memory database lives. Empty = the default ($DSH_HOME/dsh-memento/memory.db). Changing it switches to another database and reopens immediately.',
          zh: '记忆库文件放在哪。留空＝默认位置（$DSH_HOME/dsh-memento/memory.db）。改它等于换一个库，保存后立即重开。',
        }],
        ['auditRetentionDays', {
          en: 'How long audit rows are kept; 0 = forever. The audit is the only proof that everything the model saw was logged, so a short retention costs you the trail.',
          zh: '审计行留多少天，0 ＝ 永久留着。审计是「模型看到的一切都落了盘」的唯一凭据，删早了就没法回溯。',
        }],
        ['snapshotOrder', {
          en: 'Where the warm-up block sits in the system prompt; more negative is earlier (default −50). Takes effect after a DSH reload.',
          zh: '预热段插在系统提示里的相对位置。负值越靠前（默认 -50）。这一项要重载 DSH 才生效。',
        }],
      ])

      /** 取某字段的大白话说明（缺省英文）；没有说明的字段不渲染问号。 */
      function noteFor(path, language) {
        const entry = FIELD_NOTES.get(path)
        if (entry === undefined) return null
        return language === 'zh' ? entry.zh : entry.en
      }

      /** 草稿文本 → 顶层字段写入计划；无法解析的草稿返回 undefined（阻塞保存）。 */
      function parseDraftText(spec, text, currentValue) {
        if (spec.kind === 'bool') {
          if (text === 'true') return { ok: true, value: true }
          if (text === 'false') return { ok: true, value: false }
          return { ok: false }
        }
        if (spec.kind === 'choice') {
          return spec.choices.includes(text) ? { ok: true, value: text } : { ok: false }
        }
        if (spec.kind === 'decimal') {
          const trimmed = text.trim()
          const parsed = Number(trimmed)
          return trimmed !== '' && Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false }
        }
        if (spec.kind === 'number') {
          const trimmed = text.trim()
          const parsed = Number(trimmed)
          return trimmed !== '' && Number.isFinite(parsed) && Number.isInteger(parsed) ? { ok: true, value: parsed } : { ok: false }
        }
        if (spec.kind === 'policies') {
          const next = {}
          for (const rawLine of text.split('\n')) {
            const line = rawLine.trim()
            if (line === '') continue
            const eq = line.indexOf('=')
            if (eq <= 0) return { ok: false }
            const key = line.slice(0, eq).trim()
            const policy = line.slice(eq + 1).trim()
            if (key === '' || !POLICIES.includes(policy)) return { ok: false }
            next[key] = policy
          }
          return { ok: true, value: next }
        }
        // text：空串 = 恢复 base 语义由 clear 处理，这里空串写空字符串（dbPath 空 = 默认路径）。
        void currentValue
        return { ok: true, value: text }
      }

      /** 子字段格式化（快照值 → 控件文本）。 */
      function formatValue(value) {
        if (value === undefined || value === null) return ''
        if (typeof value === 'boolean') return value ? 'true' : 'false'
        return String(value)
      }

      /** policies 顶层对象的控件文本（每行 key=policy）。 */
      function formatPolicies(value) {
        if (value === null || typeof value !== 'object') return ''
        return Object.entries(value).map(([key, policy]) => `${key}=${policy}`).join('\n')
      }

      /**
       * 暂存表单（学宿主 CardForm：staged → save 才写；revision 栅防并发覆盖）。
       * 顶层聚合：同顶层字段的多个子字段草稿一次 scope.set(top, 合并值)。
       */
      class CardForm {
        constructor(scope, onLanded) {
          this.scope = scope
          /** @type {((tops: Map<string, object>) => void) | undefined} 落盘成功回调（panel 显隐同步用）。 */
          this.onLanded = onLanded
          /** @type {Map<string, string>} */
          this.staged = new Map()
          this.saving = false
          this.failed = false
          this.listeners = new Set()
          scope.subscribe(() => this.publish())
        }

        bind(project) {
          const store = createSnapshotStore(project())
          this.listeners.add(() => store.set(project()))
          return store
        }

        stage(path, text) {
          this.staged.set(path, text)
          this.failed = false
          this.publish()
        }

        discard() {
          if (this.staged.size === 0 && !this.failed) return
          this.staged.clear()
          this.failed = false
          this.publish()
        }

        async save() {
          if (this.saving || this.staged.size === 0) return
          const snapshot = this.scope.getSnapshot()
          if (snapshot.status !== 'ready' || !snapshot.writable) return
          /** @type {Map<string, object>} */
          const tops = new Map()
          let valid = true
          for (const [path, text] of this.staged) {
            const spec = SPEC_BY_PATH.get(path)
            const keys = path.split('.')
            const top = keys[0]
            const parsed = parseDraftText(spec, text, snapshot.value)
            if (!parsed.ok) { valid = false; continue }
            const base = tops.get(top) ?? (snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value[top] : undefined)
            const merged = keys.length === 1
              ? parsed.value
              : deepMerge(base, (() => { /** @type {Record<string, unknown>} */ const out = {}; let cursor = out; for (let i = 1; i < keys.length - 1; i++) { cursor[keys[i]] = {}; cursor = cursor[keys[i]] } cursor[keys[keys.length - 1]] = parsed.value; return out })())
            tops.set(top, merged)
          }
          if (!valid || this.staged.size === 0) { this.publish(); return }
          this.saving = true
          this.failed = false
          this.publish()
          let landed = true
          for (const [top, value] of tops) {
            try {
              await this.scope.set(top, value)
            } catch {
              landed = false
            }
          }
          if (landed && typeof this.onLanded === 'function') this.onLanded(tops)
          if (landed) this.staged.clear()
          this.saving = false
          this.failed = !landed
          this.publish()
        }

        fieldState(path) {
          const spec = SPEC_BY_PATH.get(path)
          const snapshot = this.scope.getSnapshot()
          const staged = this.staged.get(path)
          const effective = pathValue(snapshot.value, path)
          const overridden = pathStored(snapshot.user, path)
          if (staged === undefined) {
            const text = spec.kind === 'policies' ? formatPolicies(effective) : formatValue(effective)
            return { text, overridden, invalid: false }
          }
          const parsed = parseDraftText(spec, staged, snapshot.value)
          return { text: staged, overridden, invalid: !parsed.ok }
        }

        shell() {
          const snapshot = this.scope.getSnapshot()
          let invalid = false
          for (const [path, text] of this.staged) {
            if (!parseDraftText(SPEC_BY_PATH.get(path), text, snapshot.value).ok) invalid = true
          }
          // 界面语言跟随「所选」语言：草稿里的 language 合法即生效，保存与否不影响 UI 语言。
          const stagedLanguage = this.staged.get('language')
          const draftLanguage = stagedLanguage === 'en' || stagedLanguage === 'zh' ? stagedLanguage : undefined
          return {
            available: snapshot.status === 'ready',
            writable: snapshot.writable === true,
            dirty: this.staged.size > 0,
            invalid,
            saving: this.saving,
            failed: this.failed,
            language: draftLanguage ?? snapshot.value?.language,
          }
        }

        publish() {
          for (const listener of this.listeners) listener()
        }
      }

      /** 字段分组（卡片 UI 布局；reload 组标注重载生效）。 */
      const FIELD_GROUPS = [
        { key: 'sectionPermissions', paths: ['writePolicy', 'writePolicies'] },
        { key: 'sectionPanel', paths: ['panel.enabled'] },
        { key: 'sectionLanguage', paths: ['language'] },
        { key: 'sectionBudgets', paths: ['budgets.user.userGlobal', 'budgets.user.workspace', 'budgets.agent.userGlobal', 'budgets.agent.workspace'] },
        { key: 'sectionLimits', paths: ['maxEntriesPerQuery', 'commandListLimit', 'commandAuditLimit'] },
        { key: 'sectionRecall', paths: ['recall.historyLimitDefault', 'recall.snippetCap', 'recall.snippetChars', 'recall.windowDays'] },
        { key: 'sectionRetrieval', paths: ['retrieval.vector'] },
        { key: 'sectionWeighting', paths: ['recall.weighting.heat', 'recall.weighting.heatSaturation', 'recall.weighting.heatHalfLifeDays', 'recall.weighting.freshness', 'recall.weighting.freshnessHalfLifeDays', 'recall.weighting.tagDiscount'] },
        { key: 'sectionPanelPage', paths: ['panelEntriesLimit', 'panelAuditLimit'] },
        { key: 'sectionProposals', paths: ['proposals.enabled', 'proposals.maxChars', 'proposals.maxPending'] },
        { key: 'sectionStorage', paths: ['dbPath', 'auditRetentionDays'] },
        { key: 'sectionAdvanced', paths: ['snapshotOrder'] },
      ]

      let styleInstalled = false
      const CARD_CSS = `
.memsec { max-width: 720px; color: inherit; font-size: 13px; }
.memsec-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.memsec-desc { margin: 0 0 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.memsec-note { margin: 0 0 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.memsec-group { margin: 22px 0 0; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2); font-size: 11px; font-weight: 600; letter-spacing: 0.03em; color: var(--dsw-alias-label-tertiary); }
.memcard-field { display: flex; flex-direction: column; gap: 2px; padding: 9px 0; }
.memcard-row { display: flex; flex: 1; flex-wrap: wrap; min-width: 0; align-items: center; gap: 10px; }
.memcard-label { flex: 1 1 auto; min-width: 0; font-size: 13px; }
.memcard-side { flex: none; display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.memcard-badges { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; }
.memcard-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.memcard-side .memcard-input { width: 220px; }
.memcard-textarea { flex: 1 1 100%; width: 100%; min-height: 64px; font: 12px/1.5 ui-monospace, monospace; resize: vertical; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: inherit; border-radius: 6px; padding: 6px 8px; }
.memcard-textarea[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.memcard-hint, .memcard-invalid { margin: 2px 0 0; font-size: 12px; }
.memcard-hint { color: var(--dsw-alias-label-tertiary); }
.memcard-invalid { color: var(--dsw-alias-state-error-primary); }
.memcard-label .memcard-help { flex: none; width: 22px; height: 22px; padding: 0; margin-left: 6px; border-radius: 50%; vertical-align: middle; color: var(--dsw-alias-label-tertiary); }
.memcard-label .memcard-help:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.memcard-note { margin: 6px 0 2px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7; }
.memsec-actions { display: flex; align-items: center; gap: 8px; margin: 22px 0 4px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.memsec-spacer { flex: 1; }
.memsec-dirty { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.memsec-failed { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.memswitch { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.memswitch-off { color: var(--dsw-alias-label-tertiary); }
`

      /** 字段行两侧小件：`已覆盖` 与 `⟳ 重载生效`，统一走官方 Tag（quiet = 提示 / neutral = 状态事实）。 */
      function FieldBadges(props) {
        const { t, spec, state } = props
        const primitives = getPrimitives()
        const badges = []
        if (state.overridden) badges.push(jsx(primitives.Tag, { key: 'ov', tone: 'neutral' }, t('overridden')))
        if (RELOAD_PATHS.has(spec.path)) {
          badges.push(withTooltip(primitives, t('reloadHint'), jsx(primitives.Tag, { key: 'rl', tone: 'quiet' }, '⟳')))
        }
        return badges.length === 0 ? null : jsx('span', { className: 'memcard-badges' }, badges)
      }

      /** 单字段控件行：label ＋ 官方控件（Switch / Input / Pill 组 / textarea）＋ 标记 ＋ reset ＋ hint/invalid ＋ 可展开说明卡。 */
      function FieldRow(props) {
        const { t, spec, state, disabled, onEdit, onReset, note } = props
        const primitives = getPrimitives()
        const [noteOpen, setNoteOpen] = react.useState(false)
        const label = t(spec.key ?? spec.path)
        const invalid = spec.kind === 'choice' ? t('invalidPolicy') : spec.kind === 'decimal' ? t('invalidDecimal') : t('invalidNumber')
        const hintKey = FIELD_HINTS.get(spec.path)
        let control
        if (spec.kind === 'bool') {
          control = jsx(primitives.Switch, {
            checked: state.text === 'true',
            disabled,
            label,
            onChange: (next) => onEdit(next ? 'true' : 'false'),
          })
        } else if (spec.kind === 'choice') {
          control = jsx('div', { className: 'memcard-pills' }, spec.choices.map((choice) => {
            const labelKey = CHOICE_LABELS[`${spec.path}:${choice}`]
            return jsx(primitives.Pill, {
              key: choice,
              active: state.text === choice,
              disabled,
              onClick: () => onEdit(choice),
            }, labelKey === undefined ? choice : t(labelKey))
          }))
        } else if (spec.kind === 'policies') {
          control = jsx('textarea', {
            className: 'memcard-textarea', disabled,
            value: state.text, 'aria-invalid': state.invalid,
            onChange: (event) => onEdit(event.target.value),
          })
        } else {
          control = jsx(primitives.Input, {
            className: 'memcard-input', disabled,
            value: state.text, 'aria-invalid': state.invalid,
            inputMode: spec.kind === 'number' ? 'numeric' : 'decimal',
            onChange: (event) => onEdit(event.target.value),
          })
        }
        return jsx('div', { className: 'memcard-field' },
          jsx('div', { className: 'memcard-row' },
            jsx('label', { className: 'memcard-label' }, label,
              note === null
                ? null
                : jsx(primitives.Button, {
                    className: 'memcard-help',
                    variant: 'ghost',
                    size: 'sm',
                    icon: jsx(primitives.IconQuestionOutline14, { size: 14 }),
                    'aria-label': t('helpLabel'),
                    'aria-expanded': noteOpen,
                    onClick: (event) => { event.preventDefault(); event.stopPropagation(); setNoteOpen(!noteOpen) },
                  }),
              jsx(FieldBadges, { t, spec, state })),
            jsx('span', { className: 'memcard-side' },
              state.overridden ? jsx(primitives.Button, { variant: 'ghost', size: 'sm', disabled, onClick: onReset }, t('reset')) : null,
              control)),
          hintKey === undefined ? null : jsx('p', { className: 'memcard-hint' }, t(hintKey)),
          state.invalid ? jsx('p', { className: 'memcard-invalid' }, invalid) : null,
          noteOpen && note !== null ? jsx('p', { className: 'memcard-note' }, note) : null,
        )
      }

      /** 设置页组件（settings.section 渲染入口；hooks share: yammoryCard → useYammoryCard）。 */
      function YammorySection(props) {
        const state = props.useYammoryCard((snapshot) => snapshot)
        const primitives = getPrimitives()
        const language = state.language === 'zh' ? 'zh' : 'en'
        const t = (key) => CARD_STRINGS[language][key] ?? key
        const blocked = !state.dirty || state.saving || state.invalid
        return jsx('div', { className: 'memsec' },
          jsx('h2', { className: 'memsec-title' }, t('title')),
          jsx('p', { className: 'memsec-desc' }, t('description')),
          !state.available || !state.writable ? jsx('p', { className: 'memsec-note' }, t('readOnly')) : null,
          state.available
            ? FIELD_GROUPS.map((group) => jsx('div', { key: group.key },
                jsx('div', { className: 'memsec-group' }, t(group.key)),
                group.paths.map((path) => {
                  const spec = SPEC_BY_PATH.get(path)
                  return jsx(FieldRow, {
                    key: path, t, spec, disabled: !state.writable,
                    note: noteFor(path, language),
                    state: state.fields[path],
                    onEdit: (text) => props.edit(path, text),
                    onReset: () => {
                      const baseValue = pathValue(props.base, path)
                      props.edit(path, spec.kind === 'policies' ? formatPolicies(baseValue) : formatValue(baseValue))
                    },
                  })
                }),
              ))
            : null,
          jsx('div', { className: 'memsec-actions' },
            state.dirty ? jsx('span', { className: 'memsec-dirty' }, t('unsaved')) : null,
            state.failed ? jsx('span', { className: 'memsec-failed' }, t('saveFailed')) : null,
            jsx('span', { className: 'memsec-spacer' }),
            jsx(primitives.Button, { variant: 'ghost', size: 'sm', disabled: !state.dirty || state.saving, onClick: props.discard }, t('discard')),
            jsx(primitives.Button, { variant: 'primary', size: 'sm', disabled: blocked, onClick: props.save }, state.saving ? t('saving') : t('save'))))
      }

      /** 控制器：scope → 暂存表单 → 设置页快照。保存落盘后同步本页悬浮按钮显隐。 */
      class YammoryCardController {
        constructor(scope) {
          this.scope = scope
          this.form = new CardForm(scope, (tops) => {
            const panel = tops instanceof Map ? tops.get('panel') : undefined
            if (panel !== null && typeof panel === 'object' && 'enabled' in panel) {
              setPanelButtonVisible(panel.enabled === true)
            }
          })
          this.store = this.form.bind(() => this.projection())
        }

        projection() {
          /** @type {Record<string, {text: string, overridden: boolean, invalid: boolean}>} */
          const fields = {}
          for (const spec of FIELD_SPECS) fields[spec.path] = this.form.fieldState(spec.path)
          return { ...this.form.shell(), fields, base: this.scope.getSnapshot().base }
        }

        inject() {
          return {
            hooks: { yammoryCard: this.store },
            edit: (path, text) => this.form.stage(path, text),
            discard: () => this.form.discard(),
            save: () => { void this.form.save() },
          }
        }
      }

/**
       * /api/memento/session 客户端面（GET 读状态 / POST 切换）。
       * 路由由 host 经 connection.fetch 注册（红队①后不得走 webServer exact）。
       * @param {string} sessionId - 当前会话 id。
       * @param {boolean} [next] - 省略 = 只读；传入 = 切换后的目标状态。
       * @returns {Promise<{enabled: boolean, language: string}>}。
       */
      async function fetchSessionSwitch(sessionId, next) {
        const response = next === undefined
          ? await fetch(`/api/memento/session?sessionId=${encodeURIComponent(sessionId)}`)
          : await fetch('/api/memento/session', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, enabled: next }),
            })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (typeof data?.enabled !== 'boolean') throw new Error('malformed response')
        return { enabled: data.enabled, language: typeof data.language === 'string' ? data.language : 'en' }
      }

      /**
       * 会话开关钮（conversation.session.header.actions，session scope）：这个会话的记忆开关。
       * 挂在会话标题栏、Agent 预设的右后（预设占 order -10 的负序带，本钮取 0）；
       * 原先的 conversation.composer.dock 官方定位是「输入框之下的环境条目」，故不取。
       * 注册被拒或拿不到 sessionId 时降级为只读显示，绝不因 UI 把插件带崩（方案 §6）。
       * @param {object} ctx - 客户端插件上下文。
       */
      function registerHeaderSwitch(ctx) {
        const slots = ctx.slots
        if (slots === undefined || slots === null) return
        try {
          ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
            name: 'conversation.session.header.actions',
            id: 'yammory-session-switch',
            order: 0,
          }, SessionSwitch)), 'yammory-system: header session switch')
        } catch {
          // 宿主拒绝该 slot：仅缺一个开关钮，命令面与拦截链不受影响。
          return
        }
      }

      /** 会话记忆开关按钮（渲染在会话标题栏；点一下即切；文案随宿主面板语言，缺省 en）。 */
      function SessionSwitch(props) {
        const sessionId = typeof props?.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : ''
        const [state, setState] = react.useState({ phase: sessionId === '' ? 'unavailable' : 'loading', enabled: true, language: 'en' })
        const [busy, setBusy] = react.useState(false)
        react.useEffect(() => {
          if (sessionId === '') return undefined
          let live = true
          fetchSessionSwitch(sessionId)
            .then((data) => { if (live) setState({ phase: 'ready', enabled: data.enabled, language: data.language }) })
            .catch(() => { if (live) setState((prev) => ({ ...prev, phase: 'failed' })) })
          return () => { live = false }
        }, [sessionId])
        const t = SWITCH_STRINGS[state.language === 'zh' ? 'zh' : 'en']
        const toggle = () => {
          if (busy || sessionId === '' || state.phase === 'failed') return
          setBusy(true)
          fetchSessionSwitch(sessionId, !state.enabled)
            .then((data) => setState({ phase: 'ready', enabled: data.enabled, language: data.language }))
            .catch(() => setState((prev) => ({ ...prev, phase: 'failed' })))
            .finally(() => setBusy(false))
        }
        const label = state.phase === 'loading' ? t.loading
          : state.phase === 'unavailable' || state.phase === 'failed' ? t.unavailable
            : state.enabled ? t.on : t.off
        const ready = state.phase === 'ready'
        // 控件换成官方 Switch（官方只给控件不给文案，故文字仍由本插件渲染）；
        // 关态只做弱色（删除线会把「记忆」二字划掉，读起来像坏了而不是已关）；提示走官方 Tooltip。
        return withTooltip(getPrimitives(), t.title, jsx('span', {
          className: `memswitch${ready && !state.enabled ? ' memswitch-off' : ''}`,
        },
          jsx(getPrimitives().Switch, {
            checked: ready ? state.enabled : true,
            disabled: busy || sessionId === '' || state.phase === 'failed',
            label: `${t.title} — ${label}`,
            onChange: toggle,
          }),
          label))
      }

      function apply(ctx) {
        let disposeDrawer = null
        /** 抽屉开合：挂载点与关闭出口都在这里收口（按钮只调这一个开关）。 */
        const setDrawerOpen = (open) => {
          if (open) {
            if (disposeDrawer === null) disposeDrawer = mountDrawer()
          } else if (disposeDrawer !== null) {
            disposeDrawer()
            disposeDrawer = null
          }
        }
        drawerClose.current = () => { setDrawerOpen(false) }
        if (!styleInstalled && typeof document !== 'undefined') {
          styleInstalled = true
          const tag = document.createElement('style')
          tag.dataset.plugin = 'yammory_system'
          tag.textContent = CARD_CSS
          document.head.appendChild(tag)
        }
        // 面板 chrome 样式表（抽屉定位 ＋ 侧栏入口几何）也在 apply 装：主路径不跑 installPanel，
        // 而侧栏入口与抽屉都要这份样式（installPanel 里那次留给降级路径，幂等）。
        installPanelStyles()
        registerHeaderSwitch(ctx)
        drawerToggle.current = () => { setDrawerOpen(disposeDrawer === null) }
        // 侧栏底部入口（官方槽 sidebar.footer.action）：与「设置」同脚区。
        // 落座与否由**工厂是否真的跑起来**判定：宿主已声明该槽时 inject 会同步调它
        // （未声明则只是等着，不抛错），所以不能只看 try/catch。注册抛错或槽位一直
        // 不来，都不静默丢入口——floatingSeat 落回右下角悬浮按钮。
        let entryInSlot = false
        try {
          ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => {
            // 槽位已声明（或后来才声明）：入口落座，并退役可能已经挂上的悬浮入口。
            entryInSlot = true
            retireFloatingSeat()
            return ctx.slots.register({
              name: 'sidebar.footer.action',
              id: 'yammory-system-entry',
              order: 20,
            }, MemoryEntryButton)
          }), 'yammory-system: sidebar entry')
        } catch {
          // 注册同步失败（同 id 撞车、kind 冲突之类）：入口落回右下角悬浮按钮。
          entryInSlot = false
        }
        floatingSeat = !entryInSlot
        // 探测一次：语言与显隐落到模块级开关（侧栏入口的文案与显隐都靠它，主路径也要跑）；
        // 悬浮按钮只属于降级路径，故 bootPanel 内部还看 floatingSeat。
        void bootPanel({ onToggle: () => { drawerToggle.current() } })
        // 抽屉走官方通栏浮层（shell.overlay）：宿主声明该槽时用它，抽屉渲染进它给的容器。
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'yammory-system-drawer', order: 40 },
          DrawerHost,
        )), 'yammory-system: shell overlay seat')
        const controller = new YammoryCardController(ctx.settingsScope.bind({ namespace: 'yammory-system' }))
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'yammory-system',
          order: 16,
          label: 'yammory-system',
          inject: () => controller.inject(),
        }, YammorySection)), 'yammory-system: settings section')
      }

      return {
        name: 'yammory_system-client',
        inject: ['slots', 'settingsScope'],
        apply,
      }
    },
  })
})()
