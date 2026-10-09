/**
 * selftest_host.mjs —— 直接验证合并后的 Host 半（index.js）能否注册成功。
 *
 * 这个测试针对的就是真实故障：这个运行时里 `ctx.get('tools')` 是 undefined，
 * 服务是靠 `inject: ['tools','commands']` 注入到 ctx 属性上的。所以 mock 必须
 * 把服务挂在 ctx 上，而不是只实现 get()；否则测试会"通过"但线上什么都不注册。
 *
 * 用法: ELECTRON_RUN_AS_NODE=1 node selftest_host.mjs
 */
import { readFileSync } from 'node:fs';

const HOST = new URL('./dsh-plugin-kaoyan-ui/index.js', import.meta.url);

const failures = [];
const check = (label, ok, detail) => {
  console.log((ok ? '  OK   ' : '  FAIL ') + label + (ok ? '' : '  <- ' + String(detail)));
  if (!ok) failures.push(label);
};

const source = readFileSync(HOST, 'utf8');
/** 去掉注释再检查，避免注释里提到 ctx.get('tools') 造成误判。 */
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('Host 半声明了 inject', /export const inject = \[[^\]]*'tools'[^\]]*'commands'[^\]]*\]/.test(source),
  (source.match(/export const inject[^\n]*/) || ['(none)'])[0]);
check('Host 半不再直接用 ctx.get(\'tools\') 取服务',
  !/ctx\.get\('tools'\)/.test(codeOnly),
  (codeOnly.match(/ctx\.get\('tools'\)[^\n]*/g) || []).slice(0, 2));

const mod = await import(HOST.href);
check('Host 模块可导入且导出 apply', typeof mod.apply === 'function', Object.keys(mod));
check('inject 内容正确',
  Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('commands'),
  mod.inject);

/** 复刻 Loader 的注入形态：服务是 ctx 上的属性，ctx.get 拿不到。 */
function makeCtx() {
  const registeredTools = [];
  const registeredCommands = [];
  const ctx = {
    get: () => undefined,                       // 关键：模拟真实环境（get 取不到）
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
    provide: () => () => {},
    logger: { info: () => {}, warn: () => {} },
    tools: {
      register: (def) => { registeredTools.push(def); return () => {}; },
      get: (name) => registeredTools.find((d) => d.name === name),
      schemas: () => registeredTools.map((d) => ({ name: d.name })),
    },
    commands: {
      register: (def) => { registeredCommands.push(def); return () => {}; },
      find: (agent, name) => registeredCommands.find((d) => d.name === name),
    },
    subprocess: {
      spawn: () => ({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => {},
        collected: {
          stdout: { readFrom: () => ({ text: '{"ok":true}', nextOffset: 8, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
      }),
    },
  };
  return { ctx, registeredTools, registeredCommands };
}

const env = makeCtx();
await mod.apply(env.ctx);

check('注册了 kaoyan_daily 工具',
  env.registeredTools.some((d) => d.name === 'kaoyan_daily'),
  env.registeredTools.map((d) => d.name));
check('注册了 /kaoyan 命令',
  env.registeredCommands.some((d) => d.name === 'kaoyan'),
  env.registeredCommands.map((d) => d.name));

const tool = env.registeredTools.find((d) => d.name === 'kaoyan_daily');
check('工具声明了 action 参数',
  !!tool && tool.parameters && tool.parameters.properties
  && !!tool.parameters.properties.action
  && Array.isArray(tool.parameters.properties.action.enum),
  tool && tool.parameters && Object.keys(tool.parameters.properties || {}));
check('工具带 output.render（返回可显示的 content）',
  !!tool && !!tool.output && typeof tool.output.render === 'function',
  tool && tool.output && Object.keys(tool.output));
if (tool) {
  const blocks = tool.output.render({}, { ok: true, data: { a: 1 } });
  check('output.render 产出 text block',
    Array.isArray(blocks) && blocks[0] && blocks[0].type === 'text', blocks);
  const value = await tool.execute({ action: 'plan' });
  check('工具 execute 能走到数据桥（返回 ok 字段）',
    !!value && typeof value === 'object' && 'ok' in value, value);
}

/* 命令 handler：走真实解析（rawInput -> method + JSON） */
const command = env.registeredCommands.find((d) => d.name === 'kaoyan');
if (command) {
  const bad = await command.handler({ rawInput: '', signal: undefined });
  check('空参数给出用法提示', bad.kind === 'error' && bad.text.includes('用法'), bad);
  const unknown = await command.handler({ rawInput: 'nope {}', signal: undefined });
  check('未知方法被拒绝', unknown.kind === 'error' && unknown.text.includes('未知方法'), unknown);
  const ok = await command.handler({ rawInput: 'plan {}', signal: undefined });
  /* 这里 subprocess 是桩，返回什么由桩决定；只断言"命令把结果原样包成 success + JSON 文本"。 */
  check('plan 命令返回 success + JSON 文本',
    ok.kind === 'success' && typeof ok.text === 'string'
    && ok.text.startsWith('{') && ok.text.includes('"ok"'),
    ok.text ? ok.text.slice(0, 160) : ok);
}

/* ---- 真实故障回归：受 inject 保护的 ctx 不能让 apply 抛异常 ---- */
{
  const base = {
    effect: (fn) => { fn(); return () => {}; },
    provide: () => () => {},
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
  };
  const protectedCtx = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'tools') throw new Error('cannot get property "tools" without inject');
      if (prop === 'commands') throw new Error('cannot get property "commands" without inject');
      return Reflect.get(target, prop, receiver);
    },
  });
  let threw = null;
  try { await mod.apply(protectedCtx); } catch (error) { threw = error; }
  check('ctx.tools 抛异常时 apply 不抛（线上真正发生的就是这个）', !threw,
    threw && threw.message);
}

/* ---- 注入武装后必须真的注册上 ---- */
{
  const armedTools = [];
  const armedCommands = [];
  const armed = {
    effect: (fn) => { fn(); return () => {}; },
    provide: () => () => {},
    logger: { info: () => {}, warn: () => {} },
    get: () => undefined,
    tools: {
      register: (d) => { armedTools.push(d.name); return () => {}; },
      get: () => undefined,
      schemas: () => [],
    },
    commands: {
      register: (d) => { armedCommands.push(d.name); return () => {}; },
      find: () => undefined,
    },
  };
  await mod.apply(armed);
  check('注入武装后注册了 kaoyan_daily 工具', armedTools.includes('kaoyan_daily'), armedTools);
  check('注入武装后注册了 kaoyan 命令', armedCommands.includes('kaoyan'), armedCommands);
}

console.log();
if (failures.length) {
  console.log('FAILED ' + failures.length + ':');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('ALL HOST CHECKS PASSED');
process.exit(0);
