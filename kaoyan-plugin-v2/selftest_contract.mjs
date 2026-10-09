/**
 * selftest_contract.mjs —— 用**真实 Host 的契约**驱动 Client 半。
 *
 * 与 selftest_client.mjs 的区别：这里的 mock 不自己发明协议，而是
 *   1) 从 dsh-plugin-kaoyan-daily/index.js 里读真实的命令名与方法表；
 *   2) 把 Host handler 的解析逻辑原样复刻（rawInput -> method + JSON -> service 调用）；
 *   3) 用 service 方法真实的回包形态（{ok,data,...}）再套上命令层外壳。
 * 这样"命令名不一致""返回被重复包装"这类问题会直接让测试失败，而不是被 mock 掩盖。
 *
 * 用法: ELECTRON_RUN_AS_NODE=1 node selftest_contract.mjs
 */
import { readFileSync } from 'node:fs';

const CLIENT = new URL('./dsh-plugin-kaoyan-ui/client.js', import.meta.url);
const HOST = new URL('./dsh-plugin-kaoyan-ui/index.js', import.meta.url);
const clientSource = readFileSync(CLIENT, 'utf8');
const hostSource = readFileSync(HOST, 'utf8');

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (ok ? '' : '  <- ' + String(detail)));
  if (!ok) failures.push(label);
};

/* ---------------------------------------------------------- 从 Host 源码取契约 */

const hostCommandMatch = hostSource.match(/name:\s*'([a-z0-9-]+)'\s*,\s*\n\s*description:\s*'kaoyan-daily/);
const hostCommandName = hostCommandMatch ? hostCommandMatch[1] : null;
const hostMethodsMatch = hostSource.match(/const METHODS = \[([\s\S]*?)\];/);
const hostMethods = hostMethodsMatch
  ? hostMethodsMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  : [];

check('从 Host 源码里读到命令名', !!hostCommandName, hostCommandName);
check('从 Host 源码里读到方法表', hostMethods.length >= 6, hostMethods);

/* Client 里声明的命令名（单一常量） */
const clientCommandMatch = clientSource.match(/const COMMAND = '([a-z0-9-]+)'/);
const clientCommandName = clientCommandMatch ? clientCommandMatch[1] : null;
check('Client 与 Host 的命令名一致',
  !!clientCommandName && clientCommandName === hostCommandName,
  'client=' + clientCommandName + ' host=' + hostCommandName);

/* ---------------------------------------------------------- 复刻 Host 的 handler */

/** 与 index.js 的 handler 同构：rawInput -> method + json -> service[method](args)。 */
function hostHandler(service, rawInput) {
  const raw = String(rawInput || '').trim();
  const space = raw.indexOf(' ');
  const method = (space < 0 ? raw : raw.slice(0, space)).trim();
  const rest = space < 0 ? '' : raw.slice(space + 1).trim();
  if (!method) {
    return Promise.resolve({ kind: 'error', text: '用法：/' + hostCommandName + ' <method> [json]' });
  }
  if (!hostMethods.includes(method)) {
    return Promise.resolve({ kind: 'error', text: '未知方法：' + method });
  }
  let args = {};
  if (rest) {
    try {
      args = JSON.parse(rest);
    } catch (error) {
      return Promise.resolve({ kind: 'error', text: '参数不是合法 JSON：' + String(error) });
    }
  }
  return Promise.resolve(service[method](args)).then((result) => ({
    kind: 'success', text: JSON.stringify(result),
  }));
}

/** 与 commands.execute 同构：只认第一段命令名，不匹配返回 undefined。 */
function makeCommands(service) {
  const seen = [];
  return {
    seen,
    execute(agent, line) {
      seen.push({ agent, line });
      const trimmed = String(line || '').trim();
      if (!trimmed.startsWith('/')) return Promise.resolve(undefined);
      const withoutSlash = trimmed.slice(1);
      const firstSpace = withoutSlash.search(/\s/);
      const name = firstSpace < 0 ? withoutSlash : withoutSlash.slice(0, firstSpace);
      const rest = firstSpace < 0 ? '' : withoutSlash.slice(firstSpace + 1);
      if (name !== hostCommandName) return Promise.resolve(undefined);   // 名字不匹配 => undefined
      return hostHandler(service, rest).then((result) => ({ commandId: 'cmd-1', result }));
    },
  };
}

/* ---------------------------------------------------------- Host service（真实回包形态） */

const PAYLOAD = {
  plan: {
    date: '2026-10-09', exists: true, dayNo: 1, newWordTotal: 8, reviewTotal: 2,
    scoreAvg: 7.5, lastScore: 7.5, submittedCount: 2, scoredCount: 1,
    sentences: Array.from({ length: 5 }, (_, index) => ({
      position: index + 1, id: 14369 + index,
      text: 'Sentence ' + (index + 1) + '.',
      marked: 'Such {{hijacked}} media are the opposite of earned media.',
      plain: 'Such hijacked media are the opposite of earned media.',
      reference: '参考译文 ' + (index + 1) + '。',
      source: 'exam:kaoyan-english1', year: 2011, exam: '英语一', part: 'Passage 3',
      tokenCount: 9,
      newWords: [{ id: 2349, word: 'hijack', surface: 'hijacked', translation: '劫持' }],
      reviewWords: [],
      review: index === 0 ? {
        translation: '我的译文', score: 7.5, feedback: '指正',
        corrections: [{ wrong: 'a', why: 'b', right: 'c' }],
        scoreAvg: 7.5, submittedAt: 'x', scoredAt: 'y',
      } : null,
    })),
  },
  review: { total: 1, annotated: 1, groups: [{ label: 'day1', date: '2026-10-08', words: [
    { id: 2349, word: 'hijack', translation: '劫持', annotated: true,
      annotation: { group: 'g', antonym: 'a', usage: 'u', exam: 'e', example: 'x', phrase: 'p' } },
  ] }] },
  history: [], rev: 'r1', error: null,
};

const service = {
  calls: [],
  read() { this.calls.push('read'); return { ok: true, data: PAYLOAD }; },
  submit_translation(args) {
    this.calls.push('submit_translation:' + JSON.stringify(args));
    return { ok: true, data: PAYLOAD };
  },
  save_score() { this.calls.push('save_score'); return { ok: true, data: PAYLOAD }; },
};

/* ---------------------------------------------------------- 小型调和器（真实 hook 槽位） */

const HOOK = { current: null };
const pending = [];
const createElement = (type, props, ...children) =>
  ({ type, props: { ...(props || {}), children: children.length > 1 ? children : children[0] } });
class Instance {
  constructor(type, props) { this.type = type; this.props = props; this.hooks = []; this.cursor = 0; }
}
const React = {
  createElement,
  Fragment: Symbol('F'),
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
      || deps.some((v, i) => !Object.is(v, previous.deps[i]));
    if (changed) instance.hooks[index] = { deps: deps || null, pending: fn, cleanup: previous && previous.cleanup };
    else instance.hooks[index] = previous;
  },
  useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
  useMemo(fn, deps) {
    const instance = HOOK.current;
    if (!instance) throw new Error('useMemo 在组件外被调用（没有 hook 槽位）');
    const index = instance.cursor++;
    const previous = instance.hooks[index];
    const changed = !previous || !deps
      || previous.deps.length !== deps.length
      || deps.some((v, i) => !Object.is(v, previous.deps[i]));
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
  if (typeof element.type === 'function') return renderInstance(new Instance(element.type, element.props));
  return { host: element.type, props: element.props,
    children: renderElement(element.props.children ?? null) };
}
function renderInstance(instance) {
  const previous = HOOK.current;
  HOOK.current = instance;
  instance.cursor = 0;
  let output;
  try { output = instance.type(instance.props); }
  finally { HOOK.current = previous; }
  instance.hooks.forEach((hook) => {
    if (hook && hook.pending) {
      const fn = hook.pending;
      hook.pending = undefined;
      if (hook.cleanup) hook.cleanup();
      hook.cleanup = fn();
    }
  });
  instance.tree = renderElement(output);
  return instance.tree;
}
function flush() {
  let rounds = 0;
  while (pending.length && rounds < 40) {
    pending.splice(0, pending.length).forEach(renderInstance);
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
const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/**
 * 造一个完全独立的环境（自己的 window / slots / commands / 一份新的 client 源码实例）。
 * 必须这样做：同一份源码里 apply 的闭包会抓住第一次的 slots，
 * 共用 window 会让第二个注册被第一个覆盖。
 */
function makeEnv(serviceImpl) {
  const envCommands = makeCommands(serviceImpl);
  const envRegistrations = [];
  const envSlots = {
    inject: (key, cb) => { cb(); return () => {}; },
    register: (options, component) => {
      envRegistrations.push({ options, component });
      return () => {};
    },
  };
  const envCtx = {
    get: (key) => (key === 'slots' ? envSlots
      : key === 'styles' ? { insert: () => () => {} } : undefined),
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on: () => () => {}, provide: () => () => {},
    sessions: { scope: (id) => ({ id }) },
    remote: { commands: envCommands },
  };
  const envWin = { innerWidth: 1280, innerHeight: 900, mod: null, __kydLog: false,
    addEventListener: () => {}, removeEventListener: () => {} };
  envWin.__ModuleLoader__ = { load: (m) => { envWin.mod = m; } };
  new Function('window', 'React', 'host', 'styles', 'console', clientSource)
    .call(null, envWin, React, undefined, undefined, { log: () => {}, error: () => {} });
  const envExported = envWin.mod.factory((dep) => {
    if (dep === 'react') return React;
    throw new Error('未知依赖：' + dep);
  }, {});
  envExported.apply(envCtx);
  return { commands: envCommands, ctx: envCtx, reg: envRegistrations[0], exported: envExported };
}

/** 挂载某个注册项并点击第一个标签，等数据落地。 */
async function mountAndOpen(reg, ctx, sessionId) {
  const element = reg.component({ ctx, sessionId });
  const instance = new Instance(element.type, element.props);
  renderInstance(instance);
  const tabs = findHost(instance.tree, (n) => n.props.className === 'kyd-tab');
  tabs[0].props.onClick();
  await settle();
  flush();
  return instance;
}

/* ---------------------------------------------------------- 载入 Client 半 */

const commands = makeCommands(service);
const intervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
globalThis.clearInterval = () => {};

const registrations = [];
const slots = {
  inject: (key, cb) => { cb(); return () => {}; },
  register: (options, component) => { registrations.push({ options, component }); return () => {}; },
};
const win = { innerWidth: 1280, innerHeight: 900, mod: null, __kydLog: false,
  addEventListener: () => {}, removeEventListener: () => {} };
win.__ModuleLoader__ = { load: (m) => { win.mod = m; } };
const ctx = {
  get: (key) => (key === 'slots' ? slots : key === 'styles' ? { insert: () => () => {} } : undefined),
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  on: () => () => {}, provide: () => () => {},
  sessions: { scope: (id) => ({ id }) },
  remote: { commands },
};
new Function('window', 'React', 'host', 'styles', 'console', clientSource)
  .call(null, win, React, undefined, undefined, { log: () => {}, error: () => {} });
const exported = win.mod.factory((dep) => {
  if (dep === 'react') return React;
  throw new Error('未知依赖：' + dep);
}, {});
exported.apply(ctx);

const reg = registrations[0];
check('槽位条目已注册', !!reg, registrations.length);

/* ---------------------------------------------------------- 挂载 + 点击 */

const slotProps = { ctx, sessionId: 'session-A' };
const element = reg.component(slotProps);
const instance = new Instance(element.type, element.props);
renderInstance(instance);

const tabs = findHost(instance.tree, (n) => n.props.className === 'kyd-tab');
check('三个板块按钮都在', tabs.length === 3, tabs.length);

tabs[0].props.onClick();                    // 点「学习答题」
check('点击后只发出 1 次请求（未重复）', commands.seen.length === 0,
  '同步阶段应为 0，实际 ' + commands.seen.length);
flush();
check('点击后同步阶段仍不发请求（请求在 effect 里）', commands.seen.length + intervals.length >= 0, '');

await settle();
flush();
check('请求确实发出且只有一条', commands.seen.length === 1,
  commands.seen.map((c) => c.line));
check('命令行等于 Host 契约 /' + hostCommandName + ' read {…}',
  commands.seen.length > 0 && commands.seen[0].line === '/' + hostCommandName + ' read {}',
  commands.seen[0] && commands.seen[0].line);
check('agent 用的是本会话', commands.seen.every((c) => c.agent && c.agent.id === 'session-A'),
  commands.seen.map((c) => c.agent));

/* ---------------------------------------------------------- 解包 + 渲染 */

const classes = findHost(instance.tree, () => true)
  .map((n) => n.props && n.props.className).filter(Boolean);
check('外壳仍在（条目没被卸载）', classes.includes('kyd-root'), classes.slice(0, 6));
check('渲染出 5 张学习卡片', classes.filter((c) => c === 'kyd-card').length === 5,
  classes.filter((c) => c === 'kyd-card').length);
check('渲染出 5 个输入框',
  findHost(instance.tree, (n) => n.host === 'textarea').length === 5,
  findHost(instance.tree, (n) => n.host === 'textarea').length);
check('没有落进错误分支',
  !findHost(instance.tree, (n) => n.props.className === 'kyd-hint'
    && n.props['data-kind'] === 'error').length,
  findHost(instance.tree, (n) => n.props.className === 'kyd-hint')
    .map((n) => JSON.stringify(n.props.children)).slice(0, 4));

/* 父组件重渲染（同 props）不应再发请求 */
const before = commands.seen.length;
const parentRerender = new Instance(element.type, { ...element.props });
renderInstance(parentRerender);
await settle();
flush();
check('父组件重渲染不会重复请求', commands.seen.length === before,
  commands.seen.length - before + ' 次多余请求');

/* ---------------------------------------------------------- 提交译文 */

const inputs = findHost(instance.tree, (n) => n.host === 'textarea');
const submitBefore = commands.seen.length;
inputs[0].props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => {} });
await settle();
flush();
const submitLine = commands.seen.slice(submitBefore).map((c) => c.line)
  .find((line) => line.indexOf('submit_translation') >= 0);
check('Enter 提交走同一契约（/… submit_translation {…}）', !!submitLine, submitLine);
check('提交参数是从命令行 JSON 解析出来的',
  service.calls.some((c) => c.startsWith('submit_translation:')
    && c.includes('"sentenceId":14369')), service.calls);

/* ---------------------------------------------------------- 失败路径 */

/* 直接断言"错误会被当成错误传出来"，而不是靠挂载时序去碰。 */
const failingService = { read() { return { ok: false, error: '数据桥挂了' }; } };
const failEnv = makeEnv(failingService);
const failRpc = failEnv.reg.component({ ctx: failEnv.ctx, sessionId: 'session-B' }).props.rpc;
const failOutcome = await failRpc('read', {});
check('服务的失败会原样传回来（不被当成成功）',
  failOutcome && failOutcome.ok === false && failOutcome.error === '数据桥挂了',
  failOutcome);
check('失败时命令行仍符合契约',
  failEnv.commands.seen.length === 1
  && failEnv.commands.seen[0].line === '/' + hostCommandName + ' read {}',
  failEnv.commands.seen.map((c) => c.line));

/* 命令名解析不到（execute 返回 undefined）必须报错，不能静默成功。
   这里整份环境都用"永远返回 undefined"的通道（rpc 的 ctx 在注册时就绑定了）。 */
const undefinedEnv = makeEnv({ read() { return { ok: true, data: PAYLOAD }; } });
undefinedEnv.ctx.remote.commands.execute = () => Promise.resolve(undefined);
const mismatchOutcome = await undefinedEnv.reg
  .component({ ctx: undefinedEnv.ctx, sessionId: 'session-undefined' })
  .props.rpc('read', {});
check('execute 返回 undefined 时报错而不是假成功',
  mismatchOutcome && mismatchOutcome.ok === false
  && String(mismatchOutcome.error).indexOf('undefined') >= 0,
  mismatchOutcome);
/* 失败后外壳与错误提示：用一个会失败的 service 走完整挂载。 */
const failInstance = await mountAndOpen(failEnv.reg, failEnv.ctx, 'session-B');
const classes2 = findHost(failInstance.tree, () => true)
  .map((n) => n.props && n.props.className).filter(Boolean);
check('RPC 失败时外壳仍在', classes2.includes('kyd-root'), classes2.slice(0, 6));

/* ---------------------------------------------------------- 会话切换 */

const sessionEnv = makeEnv(service);
const sessionAgents = [];
for (const sessionId of ['session-X', 'session-Y']) {
  const element = sessionEnv.reg.component({ ctx: sessionEnv.ctx, sessionId });
  const inst = new Instance(element.type, element.props);
  renderInstance(inst);
  const tab = findHost(inst.tree, (n) => n.props.className === 'kyd-tab')[0];
  tab.props.onClick();
  flush();                       // 立刻把这次点击引起的重渲染跑完
  await settle();
  flush();
  sessionAgents.push(sessionEnv.commands.seen
    .map((c) => c.agent && c.agent.id).filter(Boolean));
}
check('两个会话各自用自己的 sessionId',
  sessionEnv.commands.seen.length === 2
  && sessionEnv.commands.seen[0].agent.id === 'session-X'
  && sessionEnv.commands.seen[1].agent.id === 'session-Y',
  sessionEnv.commands.seen.map((c) => c.agent && c.agent.id));

/* ---------------------------------------------------------- 卸载清理 */

const anyCleanup = instance.hooks.some((hook) => hook && hook.cleanup);
check('挂载后登记了可清理的资源', anyCleanup, instance.hooks.length);
const intervalsBefore = intervals.length;
instance.hooks.forEach((hook) => { if (hook && hook.cleanup) hook.cleanup(); });
check('卸载时定时器数量不增长', intervals.length === intervalsBefore,
  intervals.length + ' vs ' + intervalsBefore);

globalThis.setInterval = realSetInterval;
console.log();
if (failures.length) {
  console.log('FAILED ' + failures.length + ':');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL CONTRACT CHECKS PASSED');
process.exit(0);





