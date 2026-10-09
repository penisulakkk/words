/**
 * selftest_render.mjs —— 用一个小型 React 调和器把槽位组件真的挂载起来。
 *
 * 和 selftest_client.mjs 的区别：那个是"按调用顺序喂 state"，这个会像真 React 一样
 * 为每个组件建立 hook 槽位、state 改变后重新渲染子树。上一版 bug（Panel 被当普通
 * 函数调用，hook 没有槽位）正是只有这种跑法才抓得到。
 *
 * 用法: ELECTRON_RUN_AS_NODE=1 node selftest_render.mjs
 */
import { readFileSync } from 'node:fs';

const FILE = new URL('./dsh-plugin-kaoyan-ui/client.js', import.meta.url);
const source = readFileSync(FILE, 'utf8');

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (ok ? '' : '  <- ' + String(detail)));
  if (!ok) failures.push(label);
};

/* ---------------------------------------------------------- 调和器 */

const HOOK = { current: null };
const Fragment = Symbol('Fragment');

function createElement(type, props, ...children) {
  const flat = children.length > 1 ? children : children[0];
  return { type, props: { ...(props || {}), children: flat } };
}

/** 一个组件实例：持有自己的 hooks 数组。 */
class Instance {
  constructor(type, props) {
    this.type = type;
    this.props = props;
    this.hooks = [];
    this.cursor = 0;
    this.dirty = true;
    this.unmounted = false;
    this.tree = null;
  }
}

const pending = [];

function scheduleDirty(instance) {
  if (!instance.unmounted) pending.push(instance);
}

const React = {
  createElement,
  Fragment,
  useState(initial) {
    const instance = HOOK.current;
    if (!instance) throw new Error('useState 在组件外被调用（没有 hook 槽位）');
    const index = instance.cursor++;
    if (instance.hooks.length <= index) {
      instance.hooks[index] = {
        value: typeof initial === 'function' ? initial() : initial,
      };
    }
    const hook = instance.hooks[index];
    return [hook.value, (next) => {
      const value = typeof next === 'function' ? next(hook.value) : next;
      if (!Object.is(value, hook.value)) {
        hook.value = value;
        scheduleDirty(instance);
      }
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
    if (changed) {
      if (previous && previous.cleanup) previous.cleanup();
      instance.hooks[index] = { deps: deps || null, cleanup: undefined, pending: fn };
    } else {
      instance.hooks[index] = previous;
    }
  },
  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps);
  },
  useMemo(fn, deps) {
    const instance = HOOK.current;
    if (!instance) throw new Error('useMemo 在组件外被调用（没有 hook 槽位）');
    const index = instance.cursor++;
    const previous = instance.hooks[index];
    const changed = !previous || !deps
      || previous.deps.length !== deps.length
      || deps.some((value, i) => !Object.is(value, previous.deps[i]));
    if (changed) {
      instance.hooks[index] = { deps, value: fn() };
    }
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

/** 渲染一棵元素树；函数组件会拿到自己的 Instance（hook 槽位）。 */
function renderElement(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null;
  if (Array.isArray(element)) return element.map(renderElement).filter(Boolean);
  if (typeof element !== 'object') return { host: 'text', text: String(element) };

  const { type, props } = element;
  if (type === Fragment) return renderElement(props.children ?? null);
  if (typeof type === 'function') {
    const instance = new Instance(type, props);
    return renderInstance(instance);
  }
  /* 宿主元素（div / button / textarea …） */
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
    instance.error = error;
    HOOK.current = previous;
    throw error;
  }
  HOOK.current = previous;

  /* 跑本轮新登记的 effect（React 在提交阶段做，这里紧接着做）。 */
  instance.hooks.forEach((hook) => {
    if (hook && hook.pending) {
      const fn = hook.pending;
      hook.pending = undefined;
      try {
        hook.cleanup = fn();
      } catch (error) {
        instance.effectError = error;
      }
    }
  });

  instance.tree = renderElement(output);
  instance.error = undefined;
  return instance.tree;
}

/** 反复处理 setState 引起的重渲染，最多 30 轮，避免死循环。 */
function flush(maxRounds = 30) {
  let rounds = 0;
  while (pending.length && rounds < maxRounds) {
    const batch = pending.splice(0, pending.length);
    batch.forEach((instance) => { if (!instance.unmounted) renderInstance(instance); });
    rounds += 1;
  }
  return rounds;
}

function findHost(tree, predicate, out = []) {
  if (!tree) return out;
  if (Array.isArray(tree)) { tree.forEach((node) => findHost(node, predicate, out)); return out; }
  if (tree.host === 'text') return out;
  if (predicate(tree)) out.push(tree);
  findHost(tree.children, predicate, out);
  return out;
}

function textOf(tree) {
  if (!tree) return '';
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  if (tree.host === 'text') return tree.text;
  return textOf(tree.children);
}

/* ---------------------------------------------------------- 环境 */

const calls = [];
const registrations = [];
const win = { innerWidth: 1280, innerHeight: 900, mod: null,
  addEventListener: () => {}, removeEventListener: () => {} };
win.__ModuleLoader__ = { load: (m) => { win.mod = m; } };

const slots = {
  inject: (key, cb) => { cb(); return () => {}; },
  register: (options, component) => { registrations.push({ options, component }); return () => {}; },
};
const ctx = {
  get: (key) => (key === 'slots' ? slots : key === 'styles' ? { insert: () => () => {} } : undefined),
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  on: () => () => {},
  provide: () => () => {},
  sessions: { scope: (id) => ({ id }) },
  remote: { commands: { execute: (agent, line) => {
    calls.push({ agent, line });
    return Promise.resolve({ result: { kind: 'success',
      text: '{"plan":{"date":"2026-10-09","exists":true,"sentences":[],"scoreAvg":null},'
        + '"review":{"groups":[]},"history":[],"rev":"r","error":null}' } });
  } } },
};

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
check('注册了槽位条目', !!reg, registrations.length);

/* ---------------------------------------------------------- 真实挂载 */

/** 渲染并返回挂载点实例（它的 tree 会随 setState 更新）。 */
function mountComponent(element) {
  if (element && typeof element.type === 'function') {
    const instance = new Instance(element.type, element.props);
    renderInstance(instance);
    return instance;
  }
  renderElement(element);
  return null;
}

const slotProps = { ctx, sessionId: 'session-test' };
const mounted = mountComponent(reg.component(slotProps));
let tree = mounted && mounted.tree;
check('首次渲染不抛异常', !!tree, mounted && mounted.error);
check('收起态渲染出外壳', findHost(tree, (n) => n.props.className === 'kyd-root').length === 1,
  findHost(tree, (n) => n.props.className).map((n) => n.props.className).slice(0, 6));

const tabs = findHost(tree, (n) => n.props.className === 'kyd-tab');
check('三个板块按钮都在', tabs.length === 3, tabs.length);

/* 模拟真实点击：调用 onClick，让调和器重渲染同一个实例，再看它自己的树。 */
try {
  tabs[0].props.onClick();
  const rounds = flush();
  check('点击后重渲染没有死循环', rounds < 30, rounds);
} catch (error) {
  check('点击「学习答题」不抛异常', false, (error && error.stack) || error);
}

tree = mounted.tree;
const afterClasses = findHost(tree, (n) => n.props.className)
  .map((n) => n.props.className);
check('点击后外壳仍在（entry 没被卸载）',
  afterClasses.includes('kyd-root'), afterClasses.slice(0, 8));
check('点击后渲染出卡片或明确提示（不是空白）',
  afterClasses.includes('kyd-card') || afterClasses.includes('kyd-hint'),
  afterClasses.slice(0, 10));
check('读数据确实发出（走 commands.execute）',
  calls.some((c) => c.line.startsWith('/kaoyan read')), calls.map((c) => c.line));

console.log();
if (failures.length) {
  console.log('FAILED ' + failures.length + ':');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL RENDER CHECKS PASSED');
process.exit(0);

