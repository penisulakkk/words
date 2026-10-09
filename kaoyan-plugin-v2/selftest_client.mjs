/**
 * selftest_client.mjs —— kaoyan-daily UI 客户端自检（Node + React 桩）。
 *
 * 覆盖：
 *   • bundle 注册形态（id / factory 无副作用 / apply 注册槽位 / 只在 apply 里注册）
 *   • rpc 降级链：remote.commands.execute → remote.namespaces → builtins.host.call
 *   • 三个板块的渲染结构（堆叠卡 / 页码 / 提示语 / 得分 / 指正 / 单词本 / 六项悬停卡）
 *
 * 这不是浏览器渲染验证，只是把渲染树算出来，抓崩溃和结构错误。
 *
 * 用法: ELECTRON_RUN_AS_NODE=1 node selftest_client.mjs
 */
import { readFileSync } from 'node:fs';

const FILE = new URL('./dsh-plugin-kaoyan-ui/client.js', import.meta.url);
const source = readFileSync(FILE, 'utf8');

const failures = [];
function check(label, ok, detail) {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (ok ? '' : '  <- ' + String(detail)));
  if (!ok) failures.push(label);
}

/* ---------------------------------------------------------- React 桩 */

let active = null;
const React = {
  createElement(type, props, ...children) {
    const el = { type, props: { ...(props || {}) } };
    if (children.length) el.props.children = children.length === 1 ? children[0] : children;
    return el;
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = active ? active.states.length : 0;
    if (active && active.reuse && active.reuse[index]) {
      const hook = active.reuse[index];
      active.states.push(hook);
      return [hook.value, (next) => {
        hook.value = typeof next === 'function' ? next(hook.value) : next;
      }];
    }
    const preset = active && active.preset.length ? active.preset.shift() : undefined;
    const value = preset !== undefined ? preset
      : (typeof initial === 'function' ? initial() : initial);
    const hook = { value };
    if (active) active.states.push(hook);
    return [hook.value, (next) => {
      hook.value = typeof next === 'function' ? next(hook.value) : next;
    }];
  },
  useEffect(fn, deps) { if (active) active.effects.push({ fn, deps }); return undefined; },
  useCallback(fn) { return fn; },
  useRef(value) { return { current: value }; },
};

function render(renderFn, props, mods, reuse) {
  const prev = active;
  const slot = { states: [], effects: [], preset: [], reuse: reuse || null };
  active = slot;
  if (mods) mods(slot);
  let tree;
  try {
    tree = renderFn(props);
  } finally {
    active = prev;
  }
  return { tree, slot };
}

/* 桩里不做依赖比较：第一次渲染登记的所有 effect 跑一遍（等价于 React 的挂载），
   之后再跑就靠 ran 标记跳过，避免重复触发。 */
function runEffects(slot) {
  slot.effects.forEach((entry) => {
    if (entry.ran) return;
    entry.ran = true;
    entry.fn();
  });
}

/** 递归展开函数组件，得到宿主元素列表。 */
function expand(tree) {
  const out = [];
  const visit = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    if (typeof node.type === 'function') {
      const slot = { states: [], effects: [], preset: [], reuse: null };
      const prev = active;
      active = slot;
      let child;
      try {
        child = node.type({ ...(node.props || {}), children: undefined });
      } finally {
        active = prev;
      }
      visit(child);
      return;
    }
    out.push(node);
    if (node.props) visit(node.props.children);
  };
  visit(tree);
  return out;
}

const findAll = (tree, predicate) => expand(tree).filter(predicate);

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props && node.props.children);
}

/* ---------------------------------------------------------- 假数据 */

const plan = {
  date: '2026-10-09', exists: true, dayNo: 1, newWordTotal: 8, reviewTotal: 2,
  scoreAvg: 7.5, lastScore: 7.5, submittedCount: 2, scoredCount: 1,
  sentences: [
    { position: 1, id: 14369,
      text: 'Such hijacked media are the opposite of earned media.',
      marked: 'Such {{hijacked}} media are the opposite of earned media.',
      plain: 'Such hijacked media are the opposite of earned media.',
      reference: '这样的被劫持媒体是口碑媒体的反面。',
      source: 'exam:kaoyan-english1', year: 2011, exam: '英语一', part: 'Passage 3',
      tokenCount: 9,
      newWords: [{ id: 2349, word: 'hijack', surface: 'hijacked', translation: '劫持；揩油' }],
      reviewWords: [],
      review: { translation: '这样的被劫持媒体是免费媒体的反面', score: 7.5,
        feedback: 'hijacked 偏字面',
        corrections: [
          { wrong: '被劫持媒体', why: 'hijack 指内容被占用', right: '被绑架的媒体' },
          { wrong: '免费媒体', why: 'earned media 是口碑赢得', right: '口碑媒体' },
        ],
        scoreAvg: 7.5, submittedAt: '2026-10-09T16:30:00', scoredAt: '2026-10-09T16:31:00' } },
    ...Array.from({ length: 4 }, (_, index) => ({
      position: index + 2, id: 20000 + index,
      text: 'Sentence number ' + (index + 2) + '.',
      marked: 'Sentence number {{' + (index + 2) + '}}.',
      plain: 'Sentence number ' + (index + 2) + '.',
      reference: '第 ' + (index + 2) + ' 句。', source: 'exam:kaoyan-english1',
      year: 2019, exam: '英语一', part: 'Text1', tokenCount: 3,
      newWords: [], reviewWords: [], review: null,
    })),
  ],
};

const review = {
  total: 2, annotated: 1,
  groups: [{ label: 'day1', date: '2026-10-08', words: [
    { id: 2349, word: 'hijack', translation: '劫持；揩油', state: 'learning',
      due: '2026-10-09', interval: 1, reps: 0, lapses: 0, annotated: true,
      annotation: { group: '动词', antonym: 'release',
        usage: '账号被盗用发广告时', exam: '2011 英语一 Text3',
        example: 'The hijacked media are the opposite of earned media.',
        phrase: 'hijack a plane / hijack the agenda' } },
    { id: 1957, word: 'hostage', translation: '人质', state: 'learning',
      due: '2026-10-09', interval: 1, reps: 0, lapses: 0, annotated: false,
      annotation: null },
  ] }],
};

const history = [{ date: '2026-10-08', id: 13936,
  text: 'Today is the first day.', marked: 'Today is the first day.',
  plain: 'Today is the first day.', reference: '今天是你余生的第一天。',
  source: 'exam:kaoyan-english1', year: 2010, exam: '英语一', part: 'Text1',
  tokenCount: 5,
  review: { translation: '今天是你余生的第一天', score: 7,
    feedback: 'common 应为共同而非日常',
    corrections: [{ wrong: '日常', why: 'common 在这里是共同的', right: '共同的' }],
    scoreAvg: 5.4, submittedAt: '2026-10-08T19:32:35', scoredAt: '2026-10-08T19:32:35' } }];

const PAYLOAD = { plan, review, history, rev: '1|2|3|4|5', error: null };

/* ---------------------------------------------------------- 桩 */

const stylesCss = [];
const registrations = [];
const consoleStub = {
  log: (...args) => console.log('    [插件]', ...args),
  error: (...args) => console.log('    [插件错误]', ...args),
};

const stylesService = { insert: (css) => { stylesCss.push(css); return () => {}; } };
const slotsService = {
  inject(key, callback) {
    registrations.push({ kind: 'inject', key });
    callback();
    return () => {};
  },
  register(options, component) {
    registrations.push({ kind: 'register', options, component });
    return () => {};
  },
};

/** 造一个带某种通道形态的 ctx。 */
function makeScenario(name) {
  const calls = [];
  const ctx = {
    get: (key) => (key === 'slots' ? slotsService : key === 'styles' ? stylesService : undefined),
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
    provide: () => () => {},
    sessions: { scope: () => 'agent-stub' },
  };
  const bags = {};
  if (name === 'commands') {
    /* 学真实 commands.execute：命令名不是 kaoyan 就返回 undefined（解析不到）。 */
    ctx.remote = { commands: { execute: (agent, line) => {
      calls.push({ where: 'commands.execute', line, agent });
      const trimmed = String(line || '').trim();
      const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
      const space = withoutSlash.search(/\s/);
      const name = space < 0 ? withoutSlash : withoutSlash.slice(0, space);
      const rest = space < 0 ? '' : withoutSlash.slice(space + 1);
      if (name !== 'kaoyan') return Promise.resolve(undefined);
      if (rest.startsWith('submit_translation')) {
        const json = rest.slice(rest.indexOf(' ')).trim();
        calls.push({ where: 'commands.args', args: JSON.parse(json) });
      }
      return Promise.resolve({ result: { kind: 'success', text: JSON.stringify(PAYLOAD) } });
    } } };
  } else if (name === 'namespaces') {
    ctx.remote = { namespaces: { kaoyanDaily: {
      read: (args) => { calls.push({ where: 'namespaces.read', args });
        return Promise.resolve(PAYLOAD); },
      submit_translation: (args) => { calls.push({ where: 'namespaces.submit', args });
        return Promise.resolve(PAYLOAD); },
    } } };
  } else if (name === 'host') {
    bags.host = { call: (method, args) => { calls.push({ where: 'host.call', method, args });
      return Promise.resolve(PAYLOAD); } };
  }
  return { name, ctx, bags, calls };
}

function loadBundle(bags) {
  const win = { innerWidth: 1280, innerHeight: 900, mod: null };
  win.__ModuleLoader__ = { load: (m) => { win.mod = m; } };
  new Function('window', 'React', 'host', 'styles', 'console', source)
    .call(null, win, React, bags && bags.host, bags && bags.styles, consoleStub);
  const exported = win.mod.factory((dep) => {
    if (dep === 'react') return React;
    throw new Error('未知依赖: ' + dep);
  }, bags);
  return { win, exported };
}

const withState = (overrides) => (s) => s.preset.push(
  overrides.open, overrides.board, overrides.payload,
  overrides.error === undefined ? null : overrides.error,
  overrides.busy === undefined ? false : overrides.busy,
  overrides.drafts === undefined ? {} : overrides.drafts,
);

/** 从最近一次注册里取出 Panel（穿过 Guarded 包装）。 */
function panelFrom(ctx) {
  const reg = registrations.filter((r) => r.kind === 'register').pop();
  const inner = reg.component({ ctx, sessionId: 's' });
  return { reg, inner, Panel: inner && inner.type };
}

/* ---------------------------------------------------------- 形态一：commands */

const scenario = makeScenario('commands');
const loaded = loadBundle(scenario.bags);
check('bundle 通过 __ModuleLoader__.load 注册', !!loaded.win.mod, loaded.win.mod);
check('模块 id 与包名一致', loaded.win.mod.id === '@local/dsh-plugin-kaoyan-ui',
  loaded.win.mod.id);
check('工厂无副作用（未发起调用）', scenario.calls.length === 0, scenario.calls);
check('工厂返回 apply', typeof loaded.exported.apply === 'function',
  loaded.exported && Object.keys(loaded.exported));

loaded.exported.apply(scenario.ctx);
const reg = registrations.find((r) => r.kind === 'register');
check('注册了槽位条目', !!reg, registrations.map((r) => r.key || (r.options && r.options.id)));
check('槽位是 conversation.composer.dock，id/order 正确',
  reg && reg.options.name === 'conversation.composer.dock'
  && reg.options.id === 'kaoyan-daily' && reg.options.order === 40, reg && reg.options);
check('插入了样式（含纸张色 #F3FFEB）',
  stylesCss.some((css) => css.includes('.kyd-root') && css.includes('#F3FFEB')),
  stylesCss.length);

/**
 * 按真实链路挂载：槽位组件 -> Guarded -> Panel。
 * rpc 由槽位组件在闭包里用 ctx 造好后放进 Guarded 的 props，
 * 所以必须从这里一路往下传，不能用空 props 直接调 Guarded。
 */
function mount(props, useReg) {
  const slotEl = (useReg || reg).component(props);                     // 槽位组件调用 -> Guarded 元素
  const Guarded = slotEl && slotEl.type;                   // Guarded 组件
  const guardedEl = Guarded ? Guarded(slotEl.props) : null; // Guarded 渲染 -> Panel 元素
  const Panel = guardedEl && guardedEl.type;               // Panel 组件
  return { slotEl, guardedEl, Guarded, Panel, props: guardedEl ? guardedEl.props : null };
}

/*
 * 挂载助手：slots.register 收到的函数直接返回 h(Panel, props)，
 * 所以调用它就等于拿到 Panel 元素；rpc 由注册闭包用 ctx 造好后放在 props 里。
 */
function componentFor(useReg) {
  return (useReg || reg).component;
}

function harness(ctx, sessionId, useReg) {
  const Component = componentFor(useReg);
  const panelEl = Component({ ctx, sessionId });
  return { Component, panelEl, Panel: panelEl && panelEl.type, props: panelEl };
}

const mounted = harness(scenario.ctx, 'session-test');
check('槽位组件渲染出 Panel', typeof mounted.Panel === 'function'
  && mounted.Panel.name === 'Panel', mounted.Panel && mounted.Panel.name);
const Panel = mounted.Panel;
/* 注意返回的是 props 本身：如果返回元素，render 会再渲染一次，
   Panel 的 hook 预设就被第一次调用吃掉了。 */
const props = (ctx, sessionId, useReg) => harness(ctx, sessionId, useReg).panelEl.props;
const closed = render(Panel, props(scenario.ctx, 'session-test'));
const closedEls = expand(closed.tree);
const closedTabs = closedEls.filter((el) => el.props.className === 'kyd-tab');
check('三个板块按钮都在', closedTabs.length === 3, closedTabs.length);
check('按钮文案正确', closedTabs.map(textOf).join('|') === '学习答题|纠错评估|记忆复习',
  closedTabs.map(textOf).join('|'));
check('默认收起时不读数据', scenario.calls.length === 0, scenario.calls);

/* 打开板块一：effect 里必须发一次 read，并且走 commands.execute */
const study = render(Panel, props(scenario.ctx, 'session-test'),
  withState({ open: true, board: 'study', payload: null }));
runEffects(study.slot);
const commandLines = scenario.calls.filter((c) => c.where === 'commands.execute')
  .map((c) => c.line);
check('rpc 走 remote.commands.execute（/kaoyan read）',
  commandLines.some((line) => line.startsWith('/kaoyan read')), commandLines);
check('agent 由 ctx.sessions.scope 取出后传入',
  scenario.calls.filter((c) => c.where === 'commands.execute')
    .every((c) => c.agent === 'agent-stub'),
  scenario.calls.map((c) => c.agent));

/* 带完整 payload 再渲染一次，检查板块一结构 */
const studyReady = render(Panel, props(scenario.ctx, 'session-test'),
  withState({ open: true, board: 'study', payload: PAYLOAD }));
const studyEls = expand(studyReady.tree);
const cards = studyEls.filter((el) => el.props.className === 'kyd-card');
check('板块一渲染 5 张卡片', cards.length === 5, cards.length);
check('新词用 kyd-new 单独排版',
  studyEls.filter((el) => el.props.className === 'kyd-new').length >= 1);
const inputs = studyEls.filter((el) => el.type === 'textarea');
check('每张卡一个输入框', inputs.length === 5, inputs.length);
check('页码为 1/5 形式',
  studyEls.filter((el) => el.props.className === 'kyd-page').map(textOf).includes('1/5'),
  studyEls.filter((el) => el.props.className === 'kyd-page').map(textOf));
check('提示语为「请翻译上述语句：」',
  studyEls.filter((el) => el.props.className === 'kyd-prompt').map(textOf)
    .every((text) => text === '请翻译上述语句：'));
check('有「提交全部」兜底按钮',
  studyEls.some((el) => el.props.className === 'kyd-btn' && textOf(el) === '提交全部'));

/* Enter -> submit_translation，参数正确 */
const beforeSubmit = scenario.calls.length;
inputs[0].props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => {} });
const submitCall = scenario.calls.slice(beforeSubmit).find((c) => c.where === 'commands.args');
check('Enter 提交当前卡且参数正确',
  !!submitCall && submitCall.args.sentenceId === 14369
  && typeof submitCall.args.translation === 'string',
  scenario.calls.slice(beforeSubmit));

/* 板块二 */
const reviewView = render(Panel, props(scenario.ctx, 'session-test'),
  withState({ open: true, board: 'review', payload: PAYLOAD }));
const reviewEls = expand(reviewView.tree);
const noteCards = reviewEls.filter((el) => el.props.className === 'kyd-note-card');
check('板块二渲染今日 + 往期卡片', noteCards.length === 2, noteCards.length);
check('右上角显示得分',
  reviewEls.filter((el) => el.props.className === 'kyd-score').map(textOf)
    .some((text) => text.startsWith('7.5')),
  reviewEls.filter((el) => el.props.className === 'kyd-score').map(textOf));
check('四段标签顺序正确',
  reviewEls.filter((el) => el.props.className === 'kyd-sec-label').map(textOf).join('|')
    .startsWith('原文|参考译文|您的翻译|指正'),
  reviewEls.filter((el) => el.props.className === 'kyd-sec-label').map(textOf));
check('指正逐条渲染 (1..n)',
  reviewEls.filter((el) => el.props.className === 'kyd-corrections')
    .map((el) => el.props.children.length).join(',') === '2,1',
  reviewEls.filter((el) => el.props.className === 'kyd-corrections')
    .map((el) => el.props.children.length));

/* 板块三 */
const memory = render(Panel, props(scenario.ctx, 'session-test'),
  withState({ open: true, board: 'memory', payload: PAYLOAD }));
const memoryEls = expand(memory.tree);
check('板块三按天分组（day1）',
  memoryEls.filter((el) => el.props.className === 'kyd-day-title').map(textOf)
    .some((text) => text.startsWith('day1')),
  memoryEls.filter((el) => el.props.className === 'kyd-day-title').map(textOf));
const words = memoryEls.filter((el) => el.props.className === 'kyd-word');
check('单词本列出所有词', words.length === 2, words.length);
check('未注解的词被标灰', words.some((el) => el.props['data-annotated'] === '0'),
  words.map((el) => el.props['data-annotated']));

const memoryOwner = (() => {
  let found = null;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node.type === 'function' && node.type.name === 'MemoryBoard') {
      found = node; return;
    }
    if (node.props) visit(node.props.children);
  };
  visit(memory.tree);
  return found;
})();
check('找到 MemoryBoard', !!memoryOwner, memoryOwner && memoryOwner.type.name);
const memoryRender = render(memoryOwner.type, memoryOwner.props);
runEffects(memoryRender.slot);
const liveWords = findAll(memoryRender.tree, (el) => el.props.className === 'kyd-word');
check('悬停前注解卡未展开',
  findAll(memoryRender.tree, (el) => el.props.className === 'kyd-tip-row').length === 0);
liveWords[0].props.onMouseEnter({
  currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 200, bottom: 220 }) },
});
const afterHover = render(memoryOwner.type, memoryOwner.props, undefined,
  memoryRender.slot.states);
const tipKeys = findAll(afterHover.tree, (el) => el.props.className === 'kyd-tip-key');
check('悬停卡六项名称正确',
  tipKeys.map(textOf).join('|') === '归属|反义词|生活中常用于|真题关联|例句|常见短语搭配',
  tipKeys.map(textOf).join('|'));
check('六项内容来自预生成注解（非实时计算）',
  textOf(afterHover.tree).includes('账号被盗用发广告时')
  && textOf(afterHover.tree).includes('hijack a plane'),
  textOf(afterHover.tree).slice(0, 200));

/* ---------------------------------------------------------- 形态二：namespaces */

const ns = makeScenario('namespaces');
const nsLoaded = loadBundle(ns.bags);
registrations.length = 0;
nsLoaded.exported.apply(ns.ctx);
const nsReg = registrations.find((r) => r.kind === 'register');
const nsHarness = harness(ns.ctx, 's', nsReg);
const nsStudy = render(nsHarness.Panel, nsHarness.panelEl.props,
  withState({ open: true, board: 'study', payload: null }));
runEffects(nsStudy.slot);
check('降级到 remote.namespaces 也能读',
  ns.calls.some((c) => c.where === 'namespaces.read'), ns.calls.map((c) => c.where));

/* ---------------------------------------------------------- 形态三：host.call */

const hostCase = makeScenario('host');
const hostLoaded = loadBundle(hostCase.bags);
registrations.length = 0;
hostLoaded.exported.apply(hostCase.ctx);
const hostReg = registrations.find((r) => r.kind === 'register');
const hostHarness = harness(hostCase.ctx, 's', hostReg);
const hostStudy = render(hostHarness.Panel, hostHarness.panelEl.props,
  withState({ open: true, board: 'study', payload: null }));
runEffects(hostStudy.slot);
check('降级到 builtins.host.call 也能读',
  hostCase.calls.some((c) => c.where === 'host.call'), hostCase.calls.map((c) => c.where));

/* ---------------------------------------------------------- 无通道 */

const deadCtx = {
  get: () => undefined, effect: (fn) => { fn(); return () => {}; },
  on: () => () => {}, provide: () => () => {},
};
const deadLoaded = loadBundle({});
registrations.length = 0;
deadLoaded.exported.apply(deadCtx);
const deadReg = registrations.find((r) => r.kind === 'register');
const deadHarness = harness(deadCtx, 's', deadReg);
const deadRender = render(deadHarness.Panel, deadHarness.panelEl.props,
  withState({ open: true, board: 'study', payload: null }));
let threw = false;
try { runEffects(deadRender.slot); } catch (error) { threw = true; }
check('没有任何通道时也不抛（面板给可读错误）', !threw, threw);
check('无通道时仍渲染出外壳',
  expand(deadRender.tree).some((el) => el.props.className === 'kyd-root'));

console.log();
if (failures.length) {
  console.log('FAILED ' + failures.length + ':');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL CLIENT CHECKS PASSED');
process.exit(0);




















