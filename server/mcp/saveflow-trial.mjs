import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createFinancialContext } from '../../src/banking-core/repository.mjs';
import { createBankingCore } from '../../src/banking-core/core.mjs';
import { createPostgresBankingCore } from '../../src/banking-core/postgres-store.mjs';
import { dispatchBanking } from '../../src/banking-core/dispatch.mjs';
import { handleBillSummary } from '../../src/agent/runtime.mjs';
import { buildParsedIntent } from '../../src/agent/clarification/merge-intent.mjs';
import { ParsedIntentValidationError } from '../../src/agent/validate-parsed-intent.mjs';
import { runBankingConversation } from '../banking-orchestrator.mjs';

// Always use the seed's fixed Mock owner, regardless of DATABASE_URL or model input.
const mockContext = createFinancialContext();
if (mockContext.ownerId !== 'USR-DEMO-001') {
  throw new Error('Trial MCP requires Mock owner USR-DEMO-001');
}
const mockCore = createBankingCore();
// A process-local secret permits offline trials; restart invalidates old tokens.
const trialEnv = { CONTINUATION_TOKEN_SECRET: process.env.CONTINUATION_TOKEN_SECRET ?? randomBytes(32).toString('hex') };

const continuationFields = {
  continuationToken: z.string().max(10000).optional().describe('上一次同名工具返回的续接凭据'),
  message: z.string().max(2000).optional().describe('仅在续接时提供用户的补参或改口回答'),
  choice: z.object({ optionId: z.string().min(1) }).strict().optional().describe('仅在续接时选择服务端返回的 optionId'),
};
const reference = z.string().max(128).optional();
const amount = z.object({ amount_minor: z.number().int().safe(), currency: z.literal('CNY') }).strict().optional();

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    ...(!result.ok ? { isError: true } : {}),
  };
}

// Repository injection is for local verification only; it is never an MCP argument.
export function createTrialMcpServer(repository, { core = mockCore, env = trialEnv, now = Date.now } = {}) {
  repository ??= core.repository;
  const server = new McpServer({ name: 'saveflow-trial', version: '0.2.0' });
  server.registerTool('bill_summary', {
    description: '查询固定 Mock 用户的月账单汇总。month 格式 YYYY-MM；金额单位为人民币分；返回数据来源和截至日期。',
    // Optional here so a missing month reaches the explicit clarification result.
    inputSchema: z.object({
      month: z.string().optional().describe('账单月份，YYYY-MM，例如 2026-08；查询时必填'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ month }) => {
    if (month === undefined) {
      return toolResult({
        ok: false, kind: 'needs_clarification', missingSlots: ['month'],
        error: { code: 'MISSING_MONTH', message: '缺少 month，请提供 YYYY-MM 格式的月份，例如 2026-08。' },
      });
    }
    if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return toolResult({
        ok: false, kind: 'validation_error',
        error: { code: 'INVALID_MONTH', message: 'month 必须为有效的 YYYY-MM（年份 0001–9999，月份 01–12）。' },
      });
    }
    try {
      const result = await handleBillSummary({ action: 'bill.summary', slots: { month } }, repository);
      if (!result.ok) {
        return toolResult({
          ok: false, kind: 'business_error',
          error: result.error ?? { code: 'BILL_SUMMARY_FAILED', message: '账单业务计算失败。' },
        });
      }
      return toolResult({ ...result, data: { month, ...result.data }, currency: 'CNY', amountUnit: 'fen' });
    } catch (error) {
      return toolResult({
        ok: false, kind: 'business_error',
        error: { code: 'BILL_SUMMARY_FAILED', message: error instanceof Error ? error.message : '账单业务计算失败。' },
      });
    }
  });
  function registerConversationTool(name, action, fields, description) {
    server.registerTool(name, {
      description,
      inputSchema: z.object({ ...fields, ...continuationFields }).strict(),
      annotations: { readOnlyHint: action === 'card.get', destructiveHint: false, idempotentHint: action === 'card.get', openWorldHint: false },
    }, async args => {
      try {
        const { continuationToken, message, choice, ...slots } = args;
        const continuing = continuationToken !== undefined;
        if (continuing && Object.keys(slots).length) throw Object.assign(new Error('续接时只提交 continuationToken 与 message 或 choice，不能覆盖原草稿'), { code: 'INVALID_REQUEST' });
        if (!continuing && (message !== undefined || choice !== undefined)) throw Object.assign(new Error('message 或 choice 必须与 continuationToken 一起提交'), { code: 'INVALID_REQUEST' });
        const body = continuing ? { continuationToken, ...(message !== undefined ? { message } : {}), ...(choice !== undefined ? { choice } : {}) } : {};
        const initialIntent = continuing ? undefined : buildParsedIntent(action, slots);
        const result = await runBankingConversation(body, {
          // Only expose prepare to the shared workflow; no decision or execution capability.
          core: { prepare: core.prepare.bind(core) }, repository, env, now, initialIntent, expectedAction: action,
        });
        const clarification = result.code === 'NEEDS_CLARIFICATION';
        return toolResult({
          ok: result.code === 'OK' || clarification,
          code: result.code, message: result.message, ...result.data,
          kind: clarification ? 'needs_clarification' : result.data?.status ?? 'business_error',
          ...(result.data?.status === 'awaiting_confirmation' ? { previewOnly: true } : {}),
          currency: 'CNY', amountUnit: 'fen',
        });
      } catch (error) {
        return toolResult({
          ok: false, kind: error instanceof ParsedIntentValidationError ? 'validation_error' : 'business_error',
          error: { code: error.code ?? (error instanceof ParsedIntentValidationError ? 'VALIDATION_ERROR' : 'TRIAL_TOOL_FAILED'), message: error instanceof Error ? error.message : '工具未取得可靠结果。' },
        });
      }
    });
  }
  registerConversationTool('card_get', 'card.get', { card_ref: reference }, '查询固定 Mock 用户的卡片。card_ref 保留用户称谓，例如娱乐虚拟卡；找不到或重名时返回候选与续接凭据。');
  registerConversationTool('transfer_preview', 'transfer.create', {
    payee_ref: reference, source_account_ref: reference, amount,
  }, '只生成 Mock 转账正式预览，不确认、不执行。保留收款人和账户称谓，金额使用 {amount_minor:整数分,currency:"CNY"}；缺参或重名时按返回的凭据与候选续接。');
  registerConversationTool('card_budget_preview', 'card.set_budget', { card_ref: reference, amount }, '只生成固定 Mock 用户的卡片月预算预览，不确认、不执行。保留 card_ref 称谓；amount 使用 {amount_minor:整数分,currency:"CNY"}，预算允许 0–10000000 分。');
  registerConversationTool('card_freeze_preview', 'card.freeze', { card_ref: reference }, '只生成固定 Mock 用户的卡片冻结预览，不改变冻结状态，不确认、不执行；缺卡或重名时返回候选。');
  registerConversationTool('card_unfreeze_preview', 'card.unfreeze', { card_ref: reference }, '只生成固定 Mock 用户的卡片解冻预览，不改变冻结状态，不确认、不执行；卡片未冻结时返回现有业务错误。');

  function registerListTool(name, action, kind, description) {
    server.registerTool(name, {
      description, inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => {
      try {
        // The action is a server-side constant, never a model-supplied dispatcher argument.
        const result = await dispatchBanking(action, {}, { repository });
        if (!result.ok) return toolResult({ ...result, kind: 'business_error' });
        const context = await repository.getContextInfo();
        return toolResult({
          ...result, kind, context,
          evidence: [{ source: context.dataSource, asOf: context.asOf, entityIds: result.data.map(item => item.id) }],
          currency: 'CNY', amountUnit: 'fen',
        });
      } catch (error) {
        return toolResult({ ok: false, kind: 'business_error', error: { code: 'TRIAL_QUERY_FAILED', message: error instanceof Error ? error.message : '只读查询未取得可靠结果。' } });
      }
    });
  }
  registerListTool('subscription_list', 'subscription.list', 'subscription_result', '只读查询固定 Mock 用户的真实订阅列表、费用及使用状态，包含数据来源和截至日期；不取消订阅。');
  registerListTool('product_list', 'product.list', 'product_result', '只读查询 Mock 理财产品列表和风险、流动性等已有字段，包含数据来源和截至日期；不申购、不赎回。');
  return server;
}

export function startTrialMcpServer({
  host = process.env.SAVEFLOW_MCP_HOST ?? '127.0.0.1',
  port = Number(process.env.SAVEFLOW_MCP_PORT ?? 3333),
  core = mockCore,
  repository = core.repository,
  env = trialEnv,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP port');
  const httpServer = createServer(async (request, response) => {
    if (request.url?.split('?')[0] !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    // Stateless Streamable HTTP: no session storage or background SSE stream.
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const server = createTrialMcpServer(repository, { core, env, now });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.once('close', () => {
      void server.close().catch(error => console.error('MCP cleanup failed:', error));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP request failed' },
        }));
      } else if (!response.writableEnded) response.end();
    }
  });
  httpServer.listen(port, host);
  return httpServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Explicit opt-in for the isolated synthetic trial. Never inherit a generic
  // DATABASE_URL or expose confirm/execute through MCP.
  const connectionString = process.env.SAVEFLOW_TRIAL_DATABASE_URL;
  if (connectionString && (!process.env.CONTINUATION_TOKEN_SECRET || process.env.CONTINUATION_TOKEN_SECRET.length < 16)) {
    throw new Error('Persistent trial requires a stable CONTINUATION_TOKEN_SECRET');
  }
  const core = connectionString ? await createPostgresBankingCore({ connectionString }) : mockCore;
  const server = startTrialMcpServer({ core });
  server.once('close', () => { void core.close(); });
  server.on('listening', () => {
    const address = server.address();
    console.error(`SaveFlow trial MCP: http://${address.address}:${address.port}/mcp`);
  });
  server.on('error', error => { console.error(error); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.close(); server.closeAllConnections(); });
  }
}
