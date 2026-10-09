/**
 * selftest_render2.mjs —— 让调和器带着**真实数据**走完 点击 -> 读 -> 渲染卡片。
 *
 * 关键：mock 的 read 返回和线上同形状的 payload，并在微任务里让 setState 落地，
 * 然后重新观察实例自己的树。上一版只走到"空数据"分支，漏掉了卡片渲染。
 *
 * 用法: ELECTRON_RUN_AS_NODE=1 node selftest_render2.mjs
 */
import { readFileSync } from 'node:fs';

const FILE = new URL('./dsh-plugin-kaoyan-ui/client.js', import.meta.url);
const source = readFileSync(FILE, 'utf8');

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (ok ? '' : '  <- ' + String(detail)));
  if (!ok) failures.push(label);
};

/* ---------------------------------------------------------- 调和器（同 selftest_render） */

const HOOK = { current: null };
const Fragment = Symbol('Fragment');
const pending = [];

function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length > 1 ? children : children[0] } };
}

class Instance {
  constructor(type, props) {
    this.type = type; this.props = props;
    this.hooks = []; this.cursor = 0; this.unmounted = false; this.tree = null;
  }
}

const React = {
  createElement,
  Fragment,
  useState(initial) {
    const instance = HOOK.current;
    if (!instance) throw new Error('useState 在组件外被调用（没有 hook 槽位）');
    const index = instance.cursor++;
    if (instance.hooks.length <= index) {
      instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
    }
    const hook = instance.hooks[index];
    return [hook.value, (next) => {
      const value = typeof next === 'function' ? next(hook.value) : next;
      if (!Object.is(value, hook.value)) { hook.value = value; pending.push(instance); }
    }];
  },
  useEffect(fn, deps) {
    const instance = HOOK.current;
    if (!instance) throw new Error('useEffect 在组件外被调用（没有 hook 槽位）');
    const index = instance.cursor++;
    const previous = instance.hooks[index];
    const changed = !previous || !deps || deps.length === 0
      || previous.deps.length !== deps.length
      || deps.some((value, i) => !Object.is(value, previous.deps[i]));
    if (changed) instance.hooks[index] = { deps: deps || null, pending: fn };
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
  useMemo(fn, deps) {
    const instance = HOOK.current;
    if (!instance) throw new Error('useMemo 在组件外被调用（没有 hook 槽位）');
    const index = instance.cursor++;
    const previous = instance.hooks[index];
    const changed = !previous || !deps
      || previous.deps.length !== deps.length
      || deps.some((value, i) => !Object.is(value, previous.deps[i]));
    if (changed) instance.hooks[index] = { deps, value: fn() };
    return instance.hooks[index].value;
  },
  useRef(initial) {
    const instance = HOOK.current;
    if (!instance) throw new Error('useRef 在组件外被调用（没有 hook 槽位）');
    const index = instance.cursor++;
    if (!instance.hooks[index]) instance.hooks[index] = { current: initial };
    return instance.hooks[index];
  },
};

function renderElement(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null;
  if (Array.isArray(element)) return element.map(renderElement).filter(Boolean);
  if (typeof element !== 'object') return { host: 'text', text: String(element) };
  const { type, props } = element;
  if (type === Fragment) return renderElement(props.children ?? null);
  if (typeof type === 'function') return renderInstance(new Instance(type, props));
  return { host: type, props, children: renderElement(props.children ?? null) };
}

function renderInstance(instance) {
  const previous = HOOK.current;
  HOOK.current = instance;
  instance.cursor = 0;
  let output;
  try {
    output = instance.type(instance.props);
  } catch (error) {
    HOOK.current = previous;
    instance.error = error;
    throw error;
  }
  HOOK.current = previous;
  instance.hooks.forEach((hook) => {
    if (hook && hook.pending) {
      const fn = hook.pending;
      hook.pending = undefined;
      try { hook.cleanup = fn(); } catch (error) { instance.effectError = error; }
    }
  });
  instance.tree = renderElement(output);
  instance.error = undefined;
  return instance.tree;
}

function flush(maxRounds = 40) {
  let rounds = 0;
  while (pending.length && rounds < maxRounds) {
    const batch = pending.splice(0, pending.length);
    batch.forEach((instance) => renderInstance(instance));
    rounds += 1;
  }
  return rounds;
}

const findHost = (tree, predicate, out = []) => {
  if (!tree) return out;
  if (Array.isArray(tree)) { tree.forEach((n) => findHost(n, predicate, out)); return out; }
  if (tree.host === 'text') return out;
  if (predicate(tree)) out.push(tree);
  findHost(tree.children, predicate, out);
  return out;
};
const classes = (tree) => findHost(tree, () => true).map((n) => n.props && n.props.className)
  .filter(Boolean);
const textOf = (tree) => {
  if (!tree) return '';
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree.host === 'text') return tree.text;
  return textOf(tree.children);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ---------------------------------------------------------- 真实形状的 payload */

const PAYLOAD = {
  plan: {
    date: '2026-10-09', exists: true, dayNo: 1, newWordTotal: 8, reviewTotal: 2,
    scoreAvg: 7.5, lastScore: 7.5, submittedCount: 2, scoredCount: 1,
    sentences: Array.from({ length: 5 }, (_, index) => ({
      position: index + 1,
      id: 14369 + index,
      text: 'Sentence ' + (index + 1) + '.',
      marked: 'Such {{hijacked}} media are the opposite of earned media.',
      plain: 'Such hijacked media are the opposite of earned media.',
      reference: '参考译文 ' + (index + 1) + '。',
      source: 'exam:kaoyan-english1', year: 2011, exam: '英语一', part: 'Passage 3',
      tokenCount: 9,
      newWords: [{ id: 2349, word: 'hijack', surface: 'hijacked', translation: '劫持；揩油' }],
      reviewWords: [],
      review: index === 0 ? {
        translation: '我的译文', score: 7.5, feedback: '指正',
        corrections: [{ wrong: 'a', why: 'b', right: 'c' }],
        scoreAvg: 7.5, submittedAt: 'x', scoredAt: 'y',
      } : null,
    })),
  },
  review: { total: 2, annotated: 1, groups: [{ label: 'day1', date: '2026-10-08', words: [
    { id: 2349, word: 'hijack', translation: '劫持', annotated: true,
      annotation: { group: 'g', antonym: 'a', usage: 'u', exam: 'e', example: 'x', phrase: 'p' } },
  ] }] },
  history: [],
  rev: 'r1',
  error: null,
};

/* ---------------------------------------------------------- 环境 */

const calls = [];
const win = { innerWidth: 1280, innerHeight: 900, mod: null,
  addEventListener: () => {}, removeEventListener: () => {} };
win.__ModuleLoader__ = { load: (m) => { win.mod = m; } };
const registrations = [];
const slots = {
  inject: (key, cb) => { cb(); return () => {}; },
  register: (options, component) => { registrations.push({ options, component }); return () => {}; },
};
const intervals = [];
const ctx = {
  get: (key) => (key === 'slots' ? slots : key === 'styles' ? { insert: () => () => {} } : undefined),
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  on: () => () => {},
  provide: () => () => {},
  sessions: { scope: (id) => ({ id }) },
  timer: undefined,
  remote: { commands: { execute: (agent, line) => {
    calls.push({ agent, line });
    const trimmed = String(line || '').trim();
    const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    const space = withoutSlash.search(/\s/);
    const name = space < 0 ? withoutSlash : withoutSlash.slice(0, space);
    if (name !== 'kaoyan') return Promise.resolve(undefined);   // 真实行为：解析不到
    return Promise.resolve({ result: { kind: 'success', text: JSON.stringify(PAYLOAD) } });
  } } },
};

/* 这一轮刻意用真的 setInterval：轮询 effect 是在点击后才挂上的。 */

new Function('window', 'React', 'host', 'styles', 'console', source)
  .call(null, win, React, undefined, undefined,
    { log: (...a) => console.log('    [插件]', ...a),
      error: (...a) => console.log('    [插件错误]', ...a) });
const exported = win.mod.factory((dep) => {
  if (dep === 'react') return React;
  throw new Error('未知依赖：' + dep);
}, {});
exported.apply(ctx);

const reg = registrations[0];
const slotProps = { ctx, sessionId: 'session-test' };

const mount = () => {
  const element = reg.component(slotProps);
  const instance = new Instance(element.type, element.props);
  renderInstance(instance);
  return instance;
};

let instance = mount();
const tabs = findHost(instance.tree, (n) => n.props.className === 'kyd-tab');
check('三个板块按钮都在', tabs.length === 3, tabs.length);

/* 点击 -> read（promise）-> setPayload -> 重渲染 */
tabs[0].props.onClick();
flush();
check('点击后立即重渲染不抛异常', !instance.error, instance.error && instance.error.stack);

await settle();
flush();
check('数据到位后再渲染不抛异常', !instance.error, instance.error && instance.error.stack);

const after = classes(instance.tree);
check('外壳仍在（entry 没被卸载）', after.includes('kyd-root'), after.slice(0, 8));
check('渲染出 5 张卡片', after.filter((c) => c === 'kyd-card').length === 5,
  after.filter((c) => c === 'kyd-card').length);
check('渲染出输入框', findHost(instance.tree, (n) => n.host === 'textarea').length === 5,
  findHost(instance.tree, (n) => n.host === 'textarea').length);
check('页码含 1/5', textOf(instance.tree).includes('1/5'), textOf(instance.tree).slice(0, 120));
check('新词以 kyd-new 渲染', after.includes('kyd-new'), after.slice(0, 12));
check('诊断行仍在', textOf(instance.tree).includes('[study'), textOf(instance.tree).slice(-120));

/* 切到板块二 / 三，各渲染一次 */
const tabs2 = findHost(instance.tree, (n) => n.props.className === 'kyd-tab');
tabs2[1].props.onClick();
flush();
check('切到板块二不抛异常', !instance.error, instance.error && instance.error.stack);
check('板块二渲染出记事本卡片',
  classes(instance.tree).includes('kyd-note-card'), classes(instance.tree).slice(0, 10));

const tabs3 = findHost(instance.tree, (n) => n.props.className === 'kyd-tab');
tabs3[2].props.onClick();
flush();
check('切到板块三不抛异常', !instance.error, instance.error && instance.error.stack);
check('板块三渲染出单词本',
  classes(instance.tree).includes('kyd-draft'), classes(instance.tree).slice(0, 10));

intervals.forEach((i) => clearInterval(i.id));
console.log();
if (failures.length) {
  console.log('FAILED ' + failures.length + ':');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL RENDER2 CHECKS PASSED');
process.exit(0);


