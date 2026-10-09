/**
 * 临时排障 bundle：dsh_web_url
 *
 * 作用：把当前进程的带 token 前端地址取出来。
 * 页面提示 "dsh web authentication required; reopen the URL printed by dsh web"
 * 时，用户拿不到那条 URL；这个工具用 `ctx.connection.authenticatedUrl()`
 * 现取一份（token 是进程内新生成的）。
 *
 * 恢复访问后可以整个删掉：plugin_manager remove_bundle @local/dsh-web-url-helper
 * 以及删掉工作区里的 dsh-web-url-helper 目录。
 */

export function apply(ctx) {
  const tools = ctx.get('tools');
  const connection = ctx.get('connection');
  if (!tools || !connection) return;

  ctx.effect(() => tools.register({
    name: 'dsh_web_url',
    description: '返回当前 dsh web 进程的带 token 前端地址（页面提示 authentication required 时用）。',
    parameters: {
      type: 'object',
      properties: {
        baseUrl: {
          type: 'string',
          description: '要加 token 的地址，默认 http://127.0.0.1:19387/',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { url: { type: 'string' } } },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {};
      const base = typeof input.baseUrl === 'string' && input.baseUrl
        ? input.baseUrl
        : 'http://127.0.0.1:19387/';
      try {
        return { url: connection.authenticatedUrl(base) };
      } catch (error) {
        return { error: String((error && error.message) || error) };
      }
    },
  }), 'dsh-web-url-tool');
}

export default apply;
