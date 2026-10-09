# kaoyan-daily v2 界面层

给 DSH Web GUI 做的客户端插件（bundle）：学习答题 / 纠错评估 / 记忆复习三板块。

## 状态

| 部分 | 状态 | 证据 |
|---|---|---|
| 数据层 `kaoyan_daily_ui.py` | 已跑通 | `selftest_bridge.py` 19 项全过，读写真实 `words.db` |
| Host 半（service + `kaoyan_daily` 工具 + `/kaoyan` 命令） | **已跑通** | 工具已在运行时注册，并用真实数据返回完整 payload |
| Client 半（三板块） | 已注册并渲染 | `conversation.composer.dock` 里有 `id: kaoyan-daily` occupant |
| 端到端 | 待点一次确认 | Host 侧已用真实数据验证；客户端 5 个自检套件全过 |

## 唯一的安装单元

```
dsh-plugin-kaoyan-ui/          ← profile 里唯一的第三方 bundle
  package.json                 ← dsh.bundle.patch + dsh.client{platform:web}
  cordis.patch.yml             ← 插入一行 id: kaoyan-daily-ui
  index.js                     ← Host 半：service + kaoyan_daily 工具 + /kaoyan 命令
  client.js                    ← Client 半：三板块 React 视图
```

`dsh-plugin-kaoyan-daily/` 保留在工作区但**已停用**（Host 半已合并进 ui bundle）。

## 排障结论（踩过的坑，供以后参考）

这个运行时和官方文档有几处**实际差异**，逐个实测确认：

1. **没有 `host` builtin**。文档里的 `host.call()` 在客户端不存在
   （裸写 `host` 抛异常、工厂第二参数为空、`ctx.get('host')` 为 undefined）。
   实际可用的是 `ctx.remote`（`{ctx,name,ownerCtx,connection,namespaces,hostFacts,streams,events}`），
   所以 UI→Host 走的是 `user-actions.md` 里的 `ctx.remote.commands.execute()`。

2. **`ctx.get('tools')` 拿不到 Host 服务**。Host 半的 ctx 上，服务是**受 inject 保护的
   代理属性**：未武装时读它会抛 `cannot get property "tools" without inject`。
   正确写法是 `export const inject = ['tools', 'commands']` + 用 `ctx.tools`；
   而且取服务必须整体 try/catch —— **这个异常一旦冒到 `apply` 外面，整个 plugin 就废掉，
   工具和命令一个都不会注册**（这正是"面板出来了但点开没数据"的根因）。

3. **两个 bundle 不能用同一个 patch 行 id**。一度让两个 bundle 都用 `kaoyan-daily-ui`，
   结果只有一个能进配置，Host 那行被顶掉。

4. **客户端 bundle 是启动时组装的**：新增 bundle 必须重启应用，F5 刷新不够。

5. **客户端里绝不能自己调用带 hook 的组件函数**（`Guarded(props)` 这种）。
   脱离 React 渲染树调用会拿不到 hook 槽位直接抛错，整个槽位条目被卸载 ——
   表现就是"点一下就没了"。必须把组件交给 React：`(props) => h(Panel, props)`。

6. 崩溃弹框里的「禁用第三方插件、备份 profile patch 并重启」会把 patch 条目从
   `cordis.patch.yml` 里清掉，需要重新 `set_bundle` 装回。

## 一次操作、两个调用方

| 操作 | UI | agent |
|---|---|---|
| 读三板块数据 | `ctx.remote.commands.execute(agent, '/kaoyan read {}')` | `kaoyan_daily {action:"read"}` |
| 提交译文 | `'/kaoyan submit_translation {"sentenceId":…,"translation":…}'` | `kaoyan_daily {action:"submit_translation", …}` |
| 写得分与指正 | 同上 `save_score` | `kaoyan_daily {action:"save_score", …}` |
| 写六项注解 | ——（只读） | `kaoyan_daily {action:"add_annotations", text}` |

命令名是单一常量 `COMMAND = 'kaoyan'`，与 Host `index.js` 注册的 `name: 'kaoyan'` 一致；
`selftest_contract.mjs` 直接从 Host 源码读出命令名来比对，两边不一致就失败。

## 数据桥

`.dsh/skills/kaoyan-daily/scripts/kaoyan_daily_ui.py`（界面缓存库 `data/kaoyan-ui.db`）：
`plan` / `bootstrap` / `review` / `candidates` 读；`payload` 走 stdin 做 `submit` / `score` /
`define` / `refresh`；`cache-from-words --day YYYY-MM-DD` 把 words.db 里已有某天搬进缓存。
句子与词条仍以 `words.db` 为准，评分写记忆仍只用 `record.py`。

## 自检（全部通过）

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\新建文件夹 (6)\DeepSeek Harness.exe" selftest_host.mjs       # Host 半 16 项（含 inject 回归）
& "D:\新建文件夹 (6)\DeepSeek Harness.exe" selftest_contract.mjs   # 契约 24 项
& "D:\新建文件夹 (6)\DeepSeek Harness.exe" selftest_client.mjs     # 结构 36 项
& "D:\新建文件夹 (6)\DeepSeek Harness.exe" selftest_render.mjs     # 调和器 8 项
& "D:\新建文件夹 (6)\DeepSeek Harness.exe" selftest_render2.mjs    # 调和器+真实数据 13 项
& <bundled-python> selftest_bridge.py                              # 数据桥 19 项
```

`selftest_host.mjs` 里有一条关键回归：用「`ctx.tools` 一读就抛」的 Proxy 跑 Host 半，
断言 `apply` 不许抛 —— 这条如果早点有，就不会绕这么久。

## 界面规格（按用户确认值实现）

- 板块一：5 张堆叠卡、左右滑动、首尾循环；英文正文 微软雅黑 18 / `#436A6F` / 行距 1.5 /
  段间空一行；新词 Times New Roman 18 黑色；卡片底 `#F3FFEB` 边框 `#8497B0`；输入框白底黑字，
  与上文隔一行；提示语「请翻译上述语句：」华文中宋 14；右下角页码 `1/5`；
  Enter = 提交当前卡并翻下一张，第 5 张 Enter = 收起板块一进板块二；另有「提交全部」兜底。
- 板块二：右上角得分（如 `7.5/10`），下面依次 原文 / 参考译文 / 您的翻译 / 指正（1..n）；
  记事本质感；堆叠 + 左右滑动；并带往期已评分句子的对照卡。
- 板块三：草稿风单词本，按天分组（day1: …）；悬停弹出六项注解卡
  归属 / 反义词 / 生活中常用于 / 真题关联 / 例句 / 常见短语搭配；出题时预生成入库，悬停直接读。

官方 UI 规则：可见文本走 `ctx.locale`；容器/控件只用主题 token（`--dsw-alias-*`，
纸张色是这份学习材料本身的外观，按用户给定值保留）；不 import 任何 Harness Client 包；
不替换 app root、不往 `document.body` 追加（早期用过临时调试框，已移除）。

## 后续可做

1. 用 `kaoyan_daily add_annotations` 给当天 8 个新词补六项注解，板块三悬停卡才有内容。
2. 确认无误后卸掉排障工具：`plugin_manager remove_bundle @local/dsh-web-url-helper`
   （它只用来取带 token 的前端地址）。
3. 可以删掉已停用的 `dsh-plugin-kaoyan-daily/` 目录。
