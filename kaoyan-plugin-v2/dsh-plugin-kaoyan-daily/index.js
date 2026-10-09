/**
 * kaoyan-daily v2 界面层 —— Host 半。
 *
 * 这一半只做三件事：
 *   1. 提供一个 Host service（`kaoyanDaily`），把「数据桥」暴露给 Client 半和 agent；
 *   2. 把同一个操作注册成 agent 工具 `kaoyan_daily`，参数与 service 方法一一对应；
 *   3. 所有真正的读写都交给 skill 自带的 kaoyan_daily_ui.py，Node 侧不做业务判断。
 *
 * 数据桥脚本：.dsh/skills/kaoyan-daily/scripts/kaoyan_daily_ui.py
 *   read()          -> 三板块全部数据（bootstrap，首次会自动出题）
 *   submit()        -> 记录用户译文（板块一）
 *   score()         -> 记录得分与指正（板块二）
 *   annotate()      -> 写入新词六项注解（板块三悬停直接读）
 *   plan()          -> 只读题面
 *   review()        -> 只读单词本
 *   candidates()    -> 还缺六项注解的词 + 真题上下文
 *   refresh()       -> 强制重新出题
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE = '@local/dsh-plugin-kaoyan-daily';
const CONFIG = {
  workspaceRoot: 'C:\\Users\\19827\\Documents\\deepseek-harness\\default-workspace',
  python: 'C:\\Users\\19827\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  timeoutMs: 120000,
};

const SKILL_DIR = join(CONFIG.workspaceRoot, '.dsh', 'skills', 'kaoyan-daily');
const BRIDGE = join(SKILL_DIR, 'scripts', 'kaoyan_daily_ui.py');

/** 与 Client 半约定的 RPC 方法名（`host.call` 的第一个参数，点号前后都容忍）。 */
const METHODS = [
  'read', 'plan', 'review', 'candidates', 'refresh',
  'submit_translation', 'save_score', 'add_annotations',
];

const TOOL_ACTIONS = {
  read: '三板块全部数据（题面 + 得分/指正 + 单词本）',
  plan: '只读板块一的题面',
  review: '只读板块三的单词本',
  candidates: '列出还缺六项注解的词及其真题上下文',
  refresh: '重新出今天的 5 道题',
  submit_translation: '提交某一句的用户译文（板块一）',
  save_score: '写入某一句的得分与逐条指正（板块二）',
  add_annotations: '写入新词六项注解（板块三）',
};

function safeParse(text) {
  const start = typeof text === 'string' ? text.indexOf('{') : -1;
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

export class KaoyanDailyService {
  constructor(ctx) {
    this.ctx = ctx;
    this.chain = Promise.resolve();
  }

  /** 串行化脚本调用：SQLite 单写者，并发写会 Busy。 */
  enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async runBridge(args, payload, signal) {
    if (!existsSync(BRIDGE)) {
      return { ok: false, error: `找不到数据桥脚本：${BRIDGE}` };
    }
    const subprocess = this.ctx.get('subprocess');
    if (!subprocess) {
      return { ok: false, error: 'Host 没有 subprocess 服务，无法调用数据桥脚本。' };
    }
    const stdin = payload === undefined ? 'ignore' : { data: JSON.stringify(payload) };
    let handle;
    try {
      handle = subprocess.spawn({
        argv: [CONFIG.python, BRIDGE, ...args],
        cwd: SKILL_DIR,
        stdio: {
          stdin,
          stdout: { maxBytes: 8 * 1024 * 1024 },
          stderr: { maxBytes: 1024 * 1024 },
        },
        graceMs: 5000,
        signal,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (error) {
      return { ok: false, error: `启动数据桥失败：${error?.message ?? String(error)}` };
    }

    const timer = setTimeout(() => { try { handle.terminate(); } catch { /* 已退出 */ } },
      CONFIG.timeoutMs);
    let outcome;
    try {
      outcome = await handle.done;
    } catch (error) {
      clearTimeout(timer);
      return { ok: false, error: `数据桥进程失败：${error?.message ?? String(error)}` };
    }
    clearTimeout(timer);

    const stdout = handle.collected.stdout?.readFrom(0).text ?? '';
    const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
    const data = safeParse(stdout);
    if (outcome.exitCode !== 0 || data === undefined) {
      return {
        ok: false,
        error: (stderr || stdout || `exit ${outcome.exitCode}`).trim().slice(0, 2000),
        exitCode: outcome.exitCode,
      };
    }
    return { ok: true, data };
  }

  callBridge(args, payload, signal) {
    return this.enqueue(() => this.runBridge(args, payload, signal));
  }

  /** 三板块全部数据；首次调用会自动出题（等同 daily.py --json）。 */
  async read({ refresh = false } = {}, signal) {
    return this.callBridge(['payload'],
      { op: 'bootstrap', refresh: refresh === true }, signal);
  }

  async plan(signal) {
    return this.callBridge(['plan'], undefined, signal);
  }

  async review(signal) {
    return this.callBridge(['review'], undefined, signal);
  }

  async candidates(signal) {
    return this.callBridge(['candidates'], undefined, signal);
  }

  async refresh(_input = {}, signal) {
    return this.callBridge(['payload'], { op: 'refresh' }, signal);
  }

  async submit_translation({ sentenceId, translation } = {}, signal) {
    if (sentenceId === undefined || sentenceId === null) {
      return { ok: false, error: 'submit_translation 需要 sentenceId' };
    }
    return this.callBridge(['payload'], {
      op: 'submit', sentenceId: Number(sentenceId), translation: String(translation ?? ''),
    }, signal);
  }

  async save_score({ sentenceId, score, feedback, corrections } = {}, signal) {
    if (sentenceId === undefined || sentenceId === null) {
      return { ok: false, error: 'save_score 需要 sentenceId' };
    }
    const value = Number(score);
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      return { ok: false, error: 'save_score 的 score 必须是 0-10 的数字' };
    }
    return this.callBridge(['payload'], {
      op: 'score', sentenceId: Number(sentenceId), score: value,
      feedback: feedback ?? null,
      corrections: Array.isArray(corrections) ? corrections : null,
    }, signal);
  }

  async add_annotations({ text, source } = {}, signal) {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'add_annotations 需要 text' };
    }
    return this.callBridge(['payload'], {
      op: 'define', text, source: source ?? 'agent',
    }, signal);
  }

  /** Client 半的 `host.call(method, args)` 落到这里。 */
  async invoke(method, args, signal) {
    const name = String(method ?? '').includes('.')
      ? String(method).slice(String(method).lastIndexOf('.') + 1)
      : String(method ?? '');
    if (name === 'invoke' || !METHODS.includes(name)) {
      return { ok: false, error: `未知方法：${method}（可用：${METHODS.join(', ')}）` };
    }
    return this[name](args ?? {}, signal);
  }
}

function toolText(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** agent 侧工具：和 Client 半调用的是同一批 service 方法。 */
function registerTool(ctx, service) {
  const tools = ctx.get('tools');
  if (!tools) return;
  ctx.effect(() => tools.register({
    name: 'kaoyan_daily',
    description:
      '考研/雅思每日精读的界面数据通道。action 与界面一一对应：'
      + 'read 取三板块全部数据，submit_translation 提交用户译文，'
      + 'save_score 写入得分与逐条指正（界面板块二），'
      + 'add_annotations 写入新词六项注解（界面板块三悬停卡），'
      + 'candidates 列出还缺注解的词，refresh 重新出题。'
      + '出题本身仍用 scripts/daily.py；评分写记忆仍用 scripts/record.py。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: Object.keys(TOOL_ACTIONS), description: '要执行的操作。' },
        sentenceId: { type: 'number', description: '句子的 sentences.id（submit_translation / save_score 必填）。' },
        translation: { type: 'string', description: '用户译文（submit_translation）。' },
        score: { type: 'number', description: '10 分制得分（save_score，0-10）。' },
        feedback: { type: 'string', description: '指正摘要（save_score）。' },
        corrections: {
          type: 'array',
          description: '逐条指正（save_score），每项 {wrong, why, right}。',
          items: {
            type: 'object',
            properties: {
              wrong: { type: 'string' },
              why: { type: 'string' },
              right: { type: 'string' },
            },
            required: ['wrong', 'why', 'right'],
            additionalProperties: false,
          },
        },
        text: {
          type: 'string',
          description: '六项注解定义（add_annotations），每行 `word|归属;反义词;生活中常用于;真题关联;例句;常见短语搭配`。',
        },
        source: { type: 'string', description: '注解来源标记（add_annotations，可选）。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => toolText(value),
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {};
      const action = input.action;
      switch (action) {
        case 'read': return service.read({ refresh: input.refresh === true });
        case 'plan': return service.plan();
        case 'review': return service.review();
        case 'candidates': return service.candidates();
        case 'refresh': return service.refresh();
        case 'submit_translation':
          return service.submit_translation(input);
        case 'save_score':
          return service.save_score(input);
        case 'add_annotations':
          return service.add_annotations(input);
        default:
          return { ok: false, error: `未知 action：${action}（可用：${Object.keys(TOOL_ACTIONS).join(', ')}）` };
      }
    },
  }), 'kaoyan-daily-tool');
}

/**
 * 一次操作、两个调用方（references/user-actions.md）：
 *   1. 操作只实现一次 —— KaoyanDailyService 的方法；
 *   2. agent 走 kaoyan_daily 工具；
 *   3. UI 走 `/kaoyan <method> <json>` 命令（Client 半用 ctx.remote.commands.execute 调）。
 * 三者调用的是同一批方法，没有第二套逻辑。
 */
function registerCommands(ctx, service) {
  const commands = ctx.get('commands');
  if (!commands) return;

  ctx.effect(() => commands.register({
    name: 'kaoyan',
    description: 'kaoyan-daily 界面数据通道：read / plan / review / candidates / refresh / '
      + 'submit_translation / save_score / add_annotations，参数为 JSON。',
    input: { hint: '<method> [json]' },
    async handler(invocation) {
      const raw = String(invocation.rawInput || '').trim();
      const space = raw.indexOf(' ');
      const method = (space < 0 ? raw : raw.slice(0, space)).trim();
      const rest = space < 0 ? '' : raw.slice(space + 1).trim();
      if (!method) {
        return { kind: 'error', text: '用法：/kaoyan <method> [json]，可用方法：'
          + METHODS.join(', ') };
      }
      if (!METHODS.includes(method) || method === 'invoke') {
        return { kind: 'error', text: '未知方法：' + method + '（可用：' + METHODS.join(', ') + '）' };
      }
      let args = {};
      if (rest) {
        try {
          args = JSON.parse(rest);
        } catch (error) {
          return { kind: 'error', text: '参数不是合法 JSON：'
            + ((error && error.message) || String(error)) };
        }
      }
      const result = await service[method](args, invocation.signal);
      return { kind: 'success', text: JSON.stringify(result) };
    },
  }), 'kaoyan-daily-command');
}

export function apply(ctx) {
  const service = new KaoyanDailyService(ctx);
  ctx.effect(() => ctx.provide('kaoyanDaily', service), 'kaoyan-daily-service');
  registerTool(ctx, service);
  registerCommands(ctx, service);
  ctx.logger?.info?.(`[${PACKAGE}] kaoyan-daily 界面层 Host 半已加载（数据桥：${BRIDGE}）`);
}

export default apply;
