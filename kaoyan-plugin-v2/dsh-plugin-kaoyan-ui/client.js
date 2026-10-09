/**
 * kaoyan-daily v2 界面层 —— Client 半。
 *
 * 三个板块注册在 conversation.composer.dock（composer 下方的全宽区域）：
 *   板块一 学习答题：5 张堆叠卡片、左右滑动切换、首尾循环、Enter 提交并翻页
 *   板块二 纠错评估：右上角得分 + 原文 / 参考译文 / 您的翻译 / 逐条指正
 *   板块三 记忆复习：草稿风单词本、按天分组、悬停六项注解卡
 *
 * Client→Host 只走一条路：`rpc(method, args)`。它按运行时实际存在的入口
 * 依次尝试（ctx.remote.commands.execute → ctx.remote.namespaces →
 * 工厂 builtins.host.call），并把失败原因原样显示在面板上，不静默。
 *
 * 这个文件的形状是"官方模板做过的事 + 纯 React 渲染"：不碰 document.body、
 * 不 import 任何 Harness Client 包、样式只用主题 token（纸张色是这份学习
 * 材料本身的外观，按用户给定值保留）。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-kaoyan-ui',
  factory(require, builtins) {
    const React = require('react');
    const h = React.createElement;
    const SLOT = 'conversation.composer.dock';
    const bags = builtins && typeof builtins === 'object' ? builtins : {};

    /* ------------------------------------------------------------ 诊断日志 */

    const BUILD = 'kyd-ui 2.0.0';

    /**
     * 分阶段生命周期日志（时间戳 / 版本 / 阶段）。
     * 默认只打印 error / warn，方便直接读 Console；
     * 控制台执行 `__kydLog = 1` 可打开全部阶段日志。不记录任何 token。
     */
    function makeLog() {
      return function log(stage, detail, level) {
        const line = '[' + BUILD + '][' + new Date().toISOString() + '][' + stage + ']';
        if (level === 'error') { console.error(line, detail === undefined ? '' : detail); return; }
        if (level === 'warn') { console.warn(line, detail === undefined ? '' : detail); return; }
        let verbose = false;
        try { verbose = !!window.__kydLog; } catch (error) { verbose = false; }
        if (verbose) console.log(line, detail === undefined ? '' : detail);
      };
    }

    /* ------------------------------------------------------------ RPC */

    /* 与 Host 半一致的命令协议：Host 注册的命令名是 `kaoyan`，
       方法名作为第一个参数（`/kaoyan <method> <json>`）。
       这里刻意做成单一常量，避免两边各写一份再对不上。 */
    const COMMAND = 'kaoyan';

    function commandLine(method, args) {
      const json = (args === undefined || args === null) ? '{}' : JSON.stringify(args);
      return '/' + COMMAND + ' ' + method + ' ' + json;
    }

    /** 命令返回值的文本可能是 JSON，也可能已经带 ok/data 外壳。 */
    function parseText(text) {
      if (typeof text !== 'string') return text;
      const start = text.indexOf('{');
      if (start < 0) return { text };
      try { return JSON.parse(text.slice(start)); } catch (error) { return { text }; }
    }

    /**
     * 统一成 {ok:true,data} / {ok:false,error}，只剥一层壳。
     * 关键：execute() 在命令名解析不到时会返回 undefined —— 必须当成错误报出来，
     * 不能"成功但没数据"，否则界面会静默空白。
     */
    function shape(value) {
      if (value === undefined || value === null) {
        return { ok: false, error: '命令没有解析成功（' + ('/' + COMMAND)
          + ' 未匹配或返回 undefined）' };
      }
      /* CommandExecution：{commandId, result:{kind, text}} */
      if (typeof value === 'object' && 'result' in value) {
        const result = value.result;
        if (!result || result.kind !== 'success') {
          return { ok: false, error: (result && result.text) || '命令执行失败' };
        }
        const parsed = parseText(result.text);
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
        return { ok: true, data: parsed };
      }
      /* 已经是 {ok, data|error} 的形态（工具 / 命名空间直调）。 */
      if (typeof value === 'object' && 'ok' in value) return value;
      return { ok: true, data: value };
    }

    /**
     * 一次界面操作 = 一次 Host 调用。
     * 返回 {ok:true,data} 或 {ok:false,error}，绝不抛。
     */
    function makeRpc(ctx, sessionId, log) {
      return function rpc(method, args) {
        const remote = ctx && ctx.remote;
        const tried = [];
        log('rpc:start', { method, sessionId });

        const done = (outcome) => {
          log(outcome.ok ? 'rpc:done' : 'rpc:error',
            { method, error: outcome.ok ? undefined : outcome.error },
            outcome.ok ? undefined : 'error');
          return outcome;
        };

        /* 1) ctx.remote.commands.execute —— user-actions 文档写的那条路。 */
        const commands = remote && remote.commands;
        if (commands && typeof commands.execute === 'function') {
          tried.push('remote.commands.execute');
          try {
            const agent = ctx.sessions && typeof ctx.sessions.scope === 'function'
              ? ctx.sessions.scope(sessionId)
              : undefined;
            const line = commandLine(method, args);
            const out = commands.execute(agent, line, [], new AbortController().signal);
            return Promise.resolve(out)
              .then((value) => done(shape(value)),
                (error) => done(fail('remote.commands.execute', error)));
          } catch (error) {
            return Promise.resolve(done(fail('remote.commands.execute', error)));
          }
        }

        /* 2) ctx.remote.namespaces.<ns>.<method> —— 按命名空间直调。 */
        const namespaces = remote && remote.namespaces;
        if (namespaces) {
          const ns = namespaces.kaoyanDaily || namespaces['kaoyan-daily'];
          if (ns && typeof ns[method] === 'function') {
            tried.push('remote.namespaces.kaoyanDaily.' + method);
            try {
              return Promise.resolve(ns[method](args))
                .then((value) => done(shape(value)),
                  (error) => done(fail('remote.namespaces', error)));
            } catch (error) {
              return Promise.resolve(done(fail('remote.namespaces', error)));
            }
          }
        }

        /* 3) 工厂 builtins.host.call —— 文档里的 package-private RPC。 */
        const host = bags.host;
        if (host && typeof host.call === 'function') {
          tried.push('builtins.host.call');
          try {
            return Promise.resolve(host.call(method, args))
              .then((value) => done(shape(value)),
                (error) => done(fail('builtins.host.call', error)));
          } catch (error) {
            return Promise.resolve(done(fail('builtins.host.call', error)));
          }
        }

        return Promise.resolve(done({
          ok: false,
          error: '没有可用的 Client→Host 通道（试过：' + (tried.join(' / ') || '无')
            + '）。ctx keys: ' + (ctx ? Object.keys(ctx).join(',') : '(no ctx)'),
        }));
      };

      function fail(where, error) {
        return { ok: false, error: where + ': '
          + ((error && error.message) || String(error)).slice(0, 300) };
      }
    }

    /* ------------------------------------------------------------ 样式 */

    const CSS = `
.kyd-root {
  --kyd-ink: #436A6F;
  --kyd-paper: #F3FFEB;
  --kyd-paper-line: #8497B0;
  --kyd-note: #FBF7EC;
  --kyd-note-line: #C9BFA6;
  --kyd-draft: #FFFDF5;
  --kyd-draft-line: #B9C3A8;
  margin: 4px 0 8px;
  font-family: var(--dsw-font-family, "Microsoft YaHei", "PingFang SC", sans-serif);
}
.kyd-shell { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.kyd-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.kyd-head-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary);
  margin-right: 4px; white-space: nowrap; }
.kyd-tabs { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.kyd-tab { border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 20px; padding: 0 10px; cursor: pointer; font-family: inherit; }
.kyd-tab:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.kyd-tab[data-active="1"] { background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.kyd-btn { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 20px; padding: 0 10px; cursor: pointer; font-family: inherit; }
.kyd-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.kyd-btn[disabled] { opacity: .5; cursor: default; }
.kyd-body { padding: 10px; }
.kyd-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 4px 2px; }
.kyd-hint[data-kind="error"] { color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; }
.kyd-rail { display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory;
  scroll-behavior: smooth; padding-bottom: 8px; }
.kyd-rail::-webkit-scrollbar { height: 6px; }
.kyd-rail::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 3px; }
.kyd-card { flex: 0 0 min(430px, 88%); scroll-snap-align: start; background: var(--kyd-paper);
  border: 1px solid var(--kyd-paper-line); border-radius: 8px; padding: 14px 16px 12px;
  display: flex; flex-direction: column; box-shadow: 3px 3px 0 rgba(132,151,176,.35); }
.kyd-card-head { display: flex; align-items: baseline; gap: 8px; font-size: 11px;
  color: #5C7A80; margin-bottom: 8px; }
.kyd-badge { border: 1px solid var(--kyd-paper-line); border-radius: 999px; padding: 0 6px;
  background: #FFFFFFAA; }
.kyd-en { margin: 0 0 10px; }
.kyd-en p { margin: 0 0 18px; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 18px; line-height: 1.5; color: var(--kyd-ink); word-break: break-word; }
.kyd-en p:last-child { margin-bottom: 0; }
.kyd-new { font-family: "Times New Roman", Times, serif; font-size: 18px; color: #000000;
  font-weight: 700; }
.kyd-prompt { font-family: "STZhongsong", "华文中宋", "SimSun", serif; font-size: 14px;
  color: #2F4A4E; margin: 14px 0 6px; }
.kyd-input { width: 100%; box-sizing: border-box; resize: vertical; background: #FFFFFF;
  color: #000000; border: 1px solid var(--kyd-paper-line); border-radius: 4px;
  padding: 8px 10px; font-size: 15px; line-height: 1.6;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
.kyd-input:focus { outline: 2px solid #8497B0AA; outline-offset: 1px; }
.kyd-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.kyd-foot .kyd-spacer { flex: 1; }
.kyd-page { font-size: 13px; color: #2F4A4E; font-variant-numeric: tabular-nums;
  font-family: "Times New Roman", Times, serif; }
.kyd-new-list { margin: 8px 0 0; padding: 0; list-style: none; font-size: 12px; color: #2F4A4E; }
.kyd-new-list li { margin-top: 2px; }
.kyd-note-card { flex: 0 0 min(430px, 88%); scroll-snap-align: start; background: var(--kyd-note);
  border: 1px solid var(--kyd-note-line); border-radius: 6px; padding: 12px 14px;
  background-image: repeating-linear-gradient(to bottom, transparent 0 27px,
    rgba(185,195,168,.45) 27px 28px); background-position: 0 6px; }
.kyd-note-top { display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; margin-bottom: 10px; }
.kyd-note-date { font-size: 12px; color: #6B6250; }
.kyd-score { font-family: "Times New Roman", Times, serif; font-size: 26px; line-height: 1;
  color: #B4472C; font-weight: 700; font-variant-numeric: tabular-nums; }
.kyd-score small { font-size: 13px; color: #8A6A56; font-weight: 400; }
.kyd-sec { margin-top: 10px; }
.kyd-sec-label { font-family: "STZhongsong", "华文中宋", "SimSun", serif; font-size: 13px;
  color: #7A5C3E; margin-bottom: 3px; }
.kyd-sec-en { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 18px;
  line-height: 1.5; color: var(--kyd-ink); margin: 0; word-break: break-word; }
.kyd-sec-cn { font-size: 15px; line-height: 1.65; color: #2B2B2B; margin: 0;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif; word-break: break-word;
  white-space: pre-wrap; }
.kyd-sec-cn[data-empty="1"] { color: #9A9384; }
.kyd-corrections { margin: 0; padding: 0 0 0 2px; list-style: none; }
.kyd-corrections li { font-size: 14px; line-height: 1.7; color: #3A3226; margin-bottom: 6px;
  padding-left: 10px; border-left: 2px solid #C9BFA6; }
.kyd-corrections b { color: #B4472C; font-weight: 600; }
.kyd-feedback { font-size: 13px; color: #6B6250; margin: 6px 0 0; white-space: pre-wrap; }
.kyd-draft { background: var(--kyd-draft); border: 1px dashed var(--kyd-draft-line);
  border-radius: 6px; padding: 10px 12px;
  background-image: repeating-linear-gradient(to bottom, transparent 0 25px,
    rgba(185,195,168,.3) 25px 26px); }
.kyd-day { margin-bottom: 12px; }
.kyd-day:last-child { margin-bottom: 0; }
.kyd-day-title { font-family: "Times New Roman", Times, serif; font-size: 15px; color: #6E7F5A;
  border-bottom: 1px dashed var(--kyd-draft-line); padding-bottom: 2px; margin-bottom: 6px; }
.kyd-day-title span { font-size: 12px; color: #909A80; margin-left: 8px; }
.kyd-words { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.kyd-word { position: relative; font-family: "Times New Roman", Times, serif; font-size: 17px;
  color: #2F3A2A; cursor: help; padding: 1px 2px; border-bottom: 1px dotted var(--kyd-draft-line); }
.kyd-word:hover { color: #4C6B33; }
.kyd-word[data-annotated="0"] { color: #8A8A7A; border-bottom-style: solid; }
.kyd-word em { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-style: normal;
  font-size: 12px; color: #7C8A6C; margin-left: 4px; }
.kyd-tip { display: none; position: fixed; z-index: 2147483000; width: min(340px, 86vw);
  padding: 10px 12px; background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.28);
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 12px; }
.kyd-tip[data-open="1"] { display: block; }
.kyd-tip-head { font-family: "Times New Roman", Times, serif; font-size: 16px; font-weight: 700;
  margin-bottom: 6px; }
.kyd-tip-head em { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-style: normal;
  font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 6px; }
.kyd-tip-row { display: flex; gap: 6px; margin-top: 4px; }
.kyd-tip-key { flex: 0 0 68px; color: var(--dsw-alias-label-secondary); text-align: right; }
.kyd-tip-val { flex: 1; white-space: pre-wrap; word-break: break-word; }
.kyd-tip-pending { color: var(--dsw-alias-state-warn-primary); }
`;

    /* ------------------------------------------------------------ 文案 */

    const T = {
      title: '考研每日精读', tabStudy: '学习答题', tabReview: '纠错评估', tabMemory: '记忆复习',
      collapse: '收起', expand: '展开', refresh: '刷新', loading: '正在读取今天的题目…',
      submitAll: '提交全部', submit: '提交', prompt: '请翻译上述语句：',
      placeholder: '在此输入你的译文，Enter 提交并翻到下一张', newWords: '新词',
      empty: '今天还没有出题。点「刷新」让 agent 用 daily.py 出题。', noScore: '尚未评分',
      origin: '原文', reference: '参考译文', yours: '您的翻译', corrections: '指正',
      waiting: '已提交，等待 agent 评分（会用 record.py 写回记忆库）', avg: '今日均分',
      pendingAnnotation: '六项注解待生成',
      askAgent: '让 agent 调用 kaoyan_daily 的 add_annotations 即可补齐。',
      annGroup: '归属', annAntonym: '反义词', annUsage: '生活中常用于', annExam: '真题关联',
      annExample: '例句', annPhrase: '常见短语搭配',
      notSubmitted: '未提交', submitted: '已提交',
    };
    const t = (key) => (key in T ? T[key] : key);

    const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

    /* ------------------------------------------------------------ 文本 */

    /** 把 `{{新词}}` 拆成 [{text, isNew}]，保留换行。 */
    function splitMarked(text) {
      const chunks = [];
      String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n')
        .split('\n').forEach((line, lineIndex, arr) => {
          line.split(/\{\{(.+?)\}\}/g).forEach((value, index) => {
            if (value) chunks.push({ text: value, isNew: index % 2 === 1 });
          });
          if (lineIndex < arr.length - 1) chunks.push({ text: '\n', isNew: false });
        });
      return chunks;
    }

    function markedNodes(chunks) {
      return chunks.map((chunk, index) => (chunk.isNew
        ? h('span', { className: 'kyd-new', key: index }, chunk.text)
        : h(React.Fragment, { key: index }, chunk.text)));
    }

    /** 英文正文按空行分段（段间空一行），段内按 [A-Za-z] 断行。 */
    function paragraphs(marked) {
      const raw = String(marked === null || marked === undefined ? '' : marked)
        .replace(/\r\n?/g, '\n');
      const blocks = raw.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
      return (blocks.length ? blocks : [raw]).map((block) => splitMarked(block));
    }

    function sourceLabel(item) {
      const bits = [];
      if (item.year) bits.push(String(item.year));
      if (item.exam) bits.push(String(item.exam));
      if (item.part) bits.push(String(item.part));
      return bits.join(' · ') || item.source || '';
    }

    /* ------------------------------------------------------------ 板块一 */

    function StudyBoard(props) {
      const railRef = React.useRef(null);
      const areaRefs = React.useRef([]);
      const [page, setPage] = React.useState(1);
      const items = props.items || [];
      const total = items.length;

      React.useEffect(() => {
        const rail = railRef.current;
        if (!rail) return undefined;
        const onScroll = () => {
          const width = rail.clientWidth || 1;
          setPage(Math.min(total, Math.max(1, Math.round(rail.scrollLeft / width) + 1)));
        };
        rail.addEventListener('scroll', onScroll, { passive: true });
        return () => rail.removeEventListener('scroll', onScroll);
      }, [total]);

      const goTo = (index) => {
        const rail = railRef.current;
        const area = areaRefs.current[index];
        if (rail && area) {
          rail.scrollTo({ left: area.offsetLeft - rail.offsetLeft, behavior: 'smooth' });
          setPage(index + 1);
        }
      };
      const step = (delta) => {
        if (total) goTo(((page - 1 + delta) % total + total) % total);
      };
      const onKeyDown = (event, index) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const last = index === total - 1;
          props.onSubmit(items[index], last);
          if (!last) goTo(index + 1);
        }
      };

      return h('div', null,
        h('div', { className: 'kyd-rail', ref: railRef },
          items.map((item, index) => {
            const value = hasOwn(props.drafts, item.id) ? props.drafts[item.id]
              : ((item.review && item.review.translation) || '');
            return h(React.Fragment, { key: item.id },
              h('span', {
                ref: (node) => { if (node) areaRefs.current[index] = node; },
                'aria-hidden': true,
                style: { flex: '0 0 0', width: 0, scrollSnapAlign: 'start' },
              }),
              h('div', { className: 'kyd-card' },
                h('div', { className: 'kyd-card-head' },
                  h('span', { className: 'kyd-badge' }, String(item.position)),
                  h('span', null, sourceLabel(item)),
                  h('span', null, (item.tokenCount || '?') + ' 词'),
                  h('span', { style: { flex: 1 } }),
                  h('span', null, item.review && item.review.submittedAt
                    ? t('submitted') : t('notSubmitted'))),
                h('div', { className: 'kyd-en' },
                  paragraphs(item.marked).map((block, blockIndex) =>
                    h('p', { key: blockIndex }, markedNodes(block)))),
                (item.newWords && item.newWords.length)
                  ? h('ul', { className: 'kyd-new-list' },
                      h('li', null, h('b', null, t('newWords'))),
                      item.newWords.map((word, wordIndex) => h('li', { key: wordIndex },
                        h('span', { className: 'kyd-new' }, word.surface || word.word),
                        ' ' + (word.translation || ''))))
                  : null,
                h('div', { className: 'kyd-prompt' }, t('prompt')),
                h('textarea', {
                  className: 'kyd-input',
                  rows: 3,
                  value,
                  placeholder: t('placeholder'),
                  'aria-label': t('prompt') + item.position,
                  onChange: (event) => props.onDraft(item.id, event.target.value),
                  onKeyDown: (event) => onKeyDown(event, index),
                }),
                h('div', { className: 'kyd-foot' },
                  h('button', {
                    type: 'button', className: 'kyd-btn', disabled: props.busy,
                    onClick: () => props.onSubmit(item, index === total - 1),
                  }, t('submit')),
                  h('span', { className: 'kyd-spacer' }),
                  h('span', { className: 'kyd-page' }, item.position + '/' + total))));
          })),
        h('div', { className: 'kyd-foot' },
          h('button', { type: 'button', className: 'kyd-btn', onClick: () => step(-1) }, '‹'),
          h('button', { type: 'button', className: 'kyd-btn', onClick: () => step(1) }, '›'),
          h('span', { className: 'kyd-page' }, page + '/' + total),
          h('span', { className: 'kyd-spacer' }),
          h('button', {
            type: 'button', className: 'kyd-btn', disabled: props.busy,
            onClick: props.onSubmitAll,
          }, t('submitAll'))));
    }

    /* ------------------------------------------------------------ 板块二 */

    function ReviewBoard(props) {
      const plan = props.plan || {};
      const todays = (plan.sentences || []).filter((item) => item.review
        && (item.review.submittedAt || item.review.score !== null));
      const past = Array.isArray(props.history) ? props.history : [];
      if (!todays.length && !past.length) return h('div', { className: 'kyd-hint' }, t('waiting'));
      const cards = todays.map((item) => ({ key: 'today-' + item.id, date: plan.date, item }))
        .concat(past.map((item) => ({ key: 'past-' + item.date + '-' + item.id,
          date: item.date, item })));
      return h('div', { className: 'kyd-rail' },
        cards.map(({ key, date, item }) => {
          const review = item.review || {};
          const score = (review.score === null || review.score === undefined)
            ? null : review.score;
          const corrections = review.corrections || [];
          return h('div', { className: 'kyd-note-card', key },
            h('div', { className: 'kyd-note-top' },
              h('span', { className: 'kyd-note-date' },
                date + '　' + sourceLabel(item)
                + ((review.scoreAvg === null || review.scoreAvg === undefined)
                  ? '' : '　' + t('avg') + ' ' + review.scoreAvg + '/10')),
              h('span', { className: 'kyd-score' },
                score === null ? t('noScore') : String(score),
                score === null ? null : h('small', null, '/10'))),
            h('div', { className: 'kyd-sec' },
              h('div', { className: 'kyd-sec-label' }, t('origin')),
              h('p', { className: 'kyd-sec-en' },
                markedNodes(splitMarked(item.plain || '')))),
            h('div', { className: 'kyd-sec' },
              h('div', { className: 'kyd-sec-label' }, t('reference')),
              h('p', { className: 'kyd-sec-cn' }, item.reference || '—')),
            h('div', { className: 'kyd-sec' },
              h('div', { className: 'kyd-sec-label' }, t('yours')),
              h('p', { className: 'kyd-sec-cn', 'data-empty': review.translation ? '0' : '1' },
                review.translation || '—')),
            h('div', { className: 'kyd-sec' },
              h('div', { className: 'kyd-sec-label' },
                t('corrections') + (corrections.length ? '（1..' + corrections.length + '）' : '')),
              corrections.length
                ? h('ol', { className: 'kyd-corrections' },
                    corrections.map((entry, index) => h('li', { key: index },
                      h('b', null, entry.wrong || ''),
                      entry.why ? '　' + entry.why : '',
                      entry.right ? h('div', null, '→ ' + entry.right) : null)))
                : null,
              review.feedback
                ? h('p', { className: 'kyd-feedback' }, review.feedback)
                : (corrections.length ? null : h('div', { className: 'kyd-hint' }, t('waiting')))));
        }));
    }

    /* ------------------------------------------------------------ 板块三 */

    const ANN_FIELDS = [
      ['group', 'annGroup'], ['antonym', 'annAntonym'], ['usage', 'annUsage'],
      ['exam', 'annExam'], ['example', 'annExample'], ['phrase', 'annPhrase'],
    ];

    function MemoryBoard(props) {
      const review = props.review || { groups: [] };
      const [tip, setTip] = React.useState(null);
      const timer = React.useRef(null);
      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

      const show = (event, word) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const width = Math.min(340, window.innerWidth * 0.86);
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const below = rect.bottom + 8;
        setTip({
          word, width, left,
          top: (below + 260 > window.innerHeight) ? Math.max(8, rect.top - 268) : below,
        });
        if (timer.current) clearTimeout(timer.current);
      };
      const hide = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setTip(null), 120);
      };

      if (!review.groups || !review.groups.length) {
        return h('div', { className: 'kyd-hint' }, t('empty'));
      }
      const annotation = tip && tip.word ? tip.word.annotation : null;

      return h('div', { className: 'kyd-draft' },
        review.groups.map((group) => h('div', { className: 'kyd-day', key: group.label },
          h('div', { className: 'kyd-day-title' }, group.label,
            h('span', null, group.date),
            h('span', null, group.words.length + ' 词')),
          h('div', { className: 'kyd-words' },
            group.words.map((word) => h('span', {
              key: word.id,
              className: 'kyd-word',
              'data-annotated': word.annotated ? '1' : '0',
              tabIndex: 0,
              onMouseEnter: (event) => show(event, word),
              onMouseLeave: hide,
              onFocus: (event) => show(event, word),
              onBlur: hide,
            }, word.word, h('em', null, word.translation || '')))))),
        h('div', {
          className: 'kyd-tip',
          'data-open': tip ? '1' : '0',
          style: tip ? { left: tip.left, top: tip.top, width: tip.width } : undefined,
          onMouseEnter: () => { if (timer.current) clearTimeout(timer.current); },
          onMouseLeave: hide,
        }, (tip && tip.word)
          ? [
              h('div', { className: 'kyd-tip-head', key: 'h' }, tip.word.word,
                h('em', null, tip.word.translation || '')),
              annotation
                ? ANN_FIELDS.map(([field, label]) => h('div',
                    { className: 'kyd-tip-row', key: field },
                    h('div', { className: 'kyd-tip-key' }, t(label)),
                    h('div', { className: 'kyd-tip-val' }, annotation[field] || '—')))
                : h('div', { className: 'kyd-tip-row', key: 'p' },
                    h('div', { className: 'kyd-tip-val kyd-tip-pending' },
                      t('pendingAnnotation') + '　' + t('askAgent'))),
            ]
          : null));
    }

    /* ------------------------------------------------------------ 外壳 */

    function Panel(props) {
      const ctx = props.ctx;
      const log = props.log || makeLog();
      /*
       * rpc 的引用必须稳定：槽位组件每次渲染都会新造一个 rpc，
       * 如果直接当作 useCallback 的依赖，load 会跟着变，
       * 依赖 load 的那个 effect 就会反复触发（重复请求 / 连续 setState）。
       * 这里用 ref 存最新实现，对外暴露一个恒定的包装。
       */
      const rpcRef = React.useRef(props.rpc);
      rpcRef.current = props.rpc;
      const rpc = React.useCallback(
        (method, args) => rpcRef.current(method, args), []);
      const [open, setOpen] = React.useState(false);
      const [board, setBoard] = React.useState('study');
      const [payload, setPayload] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [drafts, setDrafts] = React.useState({});
      const mountedRef = React.useRef(true);

      /* 卸载时把"还在等响应"这件事标记掉，避免对已卸载组件 setState。 */
      React.useEffect(() => {
        mountedRef.current = true;
        log('panel:mount', { sessionId: props.sessionId });
        return () => {
          mountedRef.current = false;
          log('panel:unmount', { sessionId: props.sessionId });
        };
      }, []);

      const applyResult = React.useCallback((result) => {
        if (!mountedRef.current) return;      // 已经卸载：不要再 setState
        if (!result) {
          setError('没有收到响应');
          return;
        }
        if (result.ok) {
          const data = result.data;
          if (!data || typeof data !== 'object') {
            setError('响应里没有数据');
            return;
          }
          /* 服务方法返回 {ok,data,...}，命令层又包了一层，这里认平铺后的形态。 */
          if (data.plan) {
            setPayload(data);
            setError(data.error || null);
            log('state:payload', { sentences: data.plan.sentences
              ? data.plan.sentences.length : 0 });
          } else if (data.ok === false) {
            setError(data.error || '服务返回失败');
          } else {
            setError('响应结构不对：缺少 plan');
          }
          return;
        }
        setError(result.error || '未知错误');
      }, []);

      const load = React.useCallback((refresh) => {
        setBusy(true);
        return rpc('read', refresh ? { refresh: true } : {})
          .then((result) => { applyResult(result); setBusy(false); },
            (reason) => {
              setError('读取失败：' + ((reason && reason.message) || String(reason)));
              setBusy(false);
            });
      }, [applyResult, rpc]);

      React.useEffect(() => {
        if (open && !payload) load(false);
      }, [open, payload, load]);

      React.useEffect(() => {
        if (!open) return undefined;
        const id = setInterval(() => { rpc('read', {}).then(applyResult); }, 20000);
        return () => clearInterval(id);
      }, [open, rpc, applyResult]);

      const onDraft = React.useCallback((id, value) => {
        setDrafts((prev) => ({ ...prev, [id]: value }));
      }, []);

      const submitOne = React.useCallback((item, closeAfter) => {
        const value = hasOwn(drafts, item.id) ? drafts[item.id]
          : ((item.review && item.review.translation) || '');
        setBusy(true);
        return rpc('submit_translation', { sentenceId: item.id, translation: value })
          .then((result) => {
            applyResult(result);
            load(false);
            if (closeAfter) setBoard('review');
          })
          .then(() => setBusy(false), () => setBusy(false));
      }, [applyResult, drafts, load, rpc]);

      const submitAll = React.useCallback(() => {
        const plan = payload && payload.plan;
        if (!plan) return;
        const pending = plan.sentences.filter((item) => String(
          hasOwn(drafts, item.id) ? drafts[item.id]
            : ((item.review && item.review.translation) || '')).trim());
        setBusy(true);
        Promise.all(pending.map((item) => rpc('submit_translation',
          { sentenceId: item.id, translation: drafts[item.id] || '' })))
          .then(() => { load(false); setBoard('review'); })
          .then(() => setBusy(false), () => setBusy(false));
      }, [drafts, load, payload, rpc]);

      const plan = payload && payload.plan;
      const tabs = [['study', t('tabStudy')], ['review', t('tabReview')],
        ['memory', t('tabMemory')]];

      let body;
      if (!open) body = null;
      else if (!payload && busy) body = h('div', { className: 'kyd-hint' }, t('loading'));
      else if (!payload) {
        /* 拿不到数据就把原因写在面板上，而不是留一片空白。 */
        body = h('div', { className: 'kyd-hint', 'data-kind': 'error' },
          error || '没有拿到数据（且没有错误信息）。');
      } else if (error && !plan) {
        body = h('div', { className: 'kyd-hint', 'data-kind': 'error' }, error);
      } else if (board === 'study') {
        body = (plan && plan.exists && plan.sentences.length)
          ? h(StudyBoard, {
              items: plan.sentences, drafts, busy,
              onDraft, onSubmitAll: submitAll, onSubmit: submitOne,
            })
          : h('div', { className: 'kyd-hint' }, t('empty'));
      } else if (board === 'review') {
        body = (plan && plan.exists)
          ? h(ReviewBoard, { plan, history: payload && payload.history })
          : h('div', { className: 'kyd-hint' }, t('empty'));
      } else {
        body = h(MemoryBoard, { review: payload && payload.review });
      }

      /* 运行期诊断：把关键状态显示在面板底部，出问题时截图就能定位。 */
      const diag = '[' + board + ' open=' + (open ? 1 : 0)
        + ' busy=' + (busy ? 1 : 0)
        + ' payload=' + (payload ? (payload.plan ? 'plan' : 'empty') : 'null')
        + ' items=' + ((plan && plan.sentences) ? plan.sentences.length : '-')
        + ' err=' + (error ? '1' : '0') + ']';

      return h('div', { className: 'kyd-root' },
        h('div', { className: 'kyd-shell' },
          h('div', { className: 'kyd-head' },
            h('span', { className: 'kyd-head-title' }, t('title')),
            h('div', { className: 'kyd-tabs' },
              tabs.map(([key, label]) => h('button', {
                key, type: 'button', className: 'kyd-tab',
                'data-active': (open && board === key) ? '1' : '0',
                'aria-pressed': (open && board === key) ? 'true' : 'false',
                onClick: () => {
                  log('click:tab', { key, wasOpen: open, wasBoard: board });
                  if (open && board === key) { setOpen(false); return; }
                  setBoard(key);
                  setOpen(true);
                },
              }, label))),
            h('button', {
              type: 'button', className: 'kyd-btn', disabled: busy,
              onClick: () => load(true),
            }, t('refresh')),
            h('button', {
              type: 'button', className: 'kyd-btn',
              onClick: () => setOpen((value) => !value),
            }, open ? t('collapse') : t('expand'))),
          open
            ? h('div', { className: 'kyd-body' }, body,
                (error && plan) ? h('div', { className: 'kyd-hint', 'data-kind': 'error' }, error) : null,
                h('div', { className: 'kyd-hint' }, diag))
            : null));
    }

    /* ------------------------------------------------------------ 注册 */

    return {
      inject: ['slots'],
      apply(ctx) {
        const log = makeLog();
        try {
          log('plugin:register', { slot: SLOT, build: BUILD });
          const styles = bags.styles || (ctx.get && ctx.get('styles'));
          if (styles && typeof styles.insert === 'function') {
            ctx.effect(() => styles.insert(CSS), 'kaoyan-daily-css');
          }
          const slots = ctx.slots || (ctx.get && ctx.get('slots'));
          if (!slots || typeof slots.inject !== 'function') {
            log('plugin:register', '没有 slots 服务，无法注册面板', 'error');
            return;
          }
          /* 每个会话一个 rpc，按 sessionId 缓存，引用保持稳定。 */
          const rpcCache = new Map();
          const rpcFor = (sessionId) => {
            const key = String(sessionId);
            if (!rpcCache.has(key)) rpcCache.set(key, makeRpc(ctx, sessionId, log));
            return rpcCache.get(key);
          };
          ctx.effect(() => {
            const dispose = slots.inject(SLOT, () => slots.register(
              { name: SLOT, id: 'kaoyan-daily', order: 40 },
              /*
               * 这里必须把 Panel 交给 React 去渲染（返回值是 h(Panel, props)），
               * 不能自己调用它：Panel 里全是 hook，脱离 React 的渲染树调用会拿到
               * 空的 hook 槽位直接抛错，整个槽位条目就被卸载，看起来就是"点了就没了"。
               * rpc 按 sessionId 复用同一份，引用稳定，不会触发多余的 effect 重跑。
               */
              (props) => h(Panel, {
                ...props,
                ctx,
                log,
                rpc: rpcFor(props && props.sessionId),
              })));
            log('slot:registered', { id: 'kaoyan-daily', order: 40 });
            return () => {
              log('slot:disposed', { id: 'kaoyan-daily' });
              rpcCache.clear();
              dispose();
            };
          }, 'kaoyan-daily-slot');
        } catch (error) {
          log('plugin:register', (error && error.stack) || String(error), 'error');
        }
      },
    };
  },
});
