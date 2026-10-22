> 历史 MCP 试点/专项记录：文中的句式路由、SAVEFLOW_TRUEFORGE_* 开关、tfm1/tfb1 续接和部署结果不适用于当前 `/api/banking-agent`。独立适配器及执行桥按原合同保留；当前统一入口与限制以 [Banking Agent API](Banking-Agent-API.md) 为准。

# SaveFlow TrueForge MCP 试点

## 范围与复用

独立服务 `server/mcp/saveflow-trial.mjs` 提供账单、卡片、转账预览、订阅和理财产品查询。服务启动、工具注册和适配调用均在该文件中；澄清与预览编排提取到共享模块 `server/banking-orchestrator.mjs`。

正式入口的调用链为：`server/banking-agent.mjs` → `runBankingConversation` → `dispatchParsedIntent` → `src/agent/runtime.mjs` 的 handlers → Repository；转账使用 `prepareTransferPreview()` 调用 Core 的 `prepare()`，卡片写意图由 `handleCard()` 生成请求后调用相同 Core 的 `prepare()`。

试点直接复用正式入口使用的 **`src/agent/runtime.mjs` 的 `handleBillSummary`**，没有新增统计代码。仓库另有 `src/agent/handlers/bill-handler.ts`，它调用 `src/skills/bill/bill-skill.ts` 的 `summarizeBills`；当前正式服务实际导入的是 `.mjs` runtime，而非该 TypeScript handler。本次不修改或合并两条现有实现。

Mock 入口复用 `src/banking-core/repository.mjs` 的 `createFinancialContext()` 和 `createBankingCore()`，由 Repository 读取原有 `src/data/saveflow_mock_data.json`。固定 owner 为 `USR-DEMO-001`，启动时核对；工具输入没有用户 ID，并拒绝所有额外字段。服务始终使用自己的 Mock Core 和 Repository，不根据 `DATABASE_URL` 切换数据库，不使用正式服务的运行中状态。

本轮按要求改造正式 HTTP 入口以调用共享编排；HTTP 的访问码、来源校验、限流、请求体限制和响应结构保留。账单、卡片、转账 Skill/Core 业务函数、Mock 文件和原 Skill 参数未修改。新增卡片预览的续接凭据，支持后续改金额或换卡。

所有预览工具只调用 Core `prepare()`，返回 `awaiting_confirmation` 和 `previewOnly: true`。模型端没有 `action.decide` 或 `action.execute`，不能完成确认或执行。转账预览不改变余额或交易记录；卡片预览不改变预算或冻结状态，但会沿用 Core 的操作记录和 `previewGeneration` 计数，用于防止旧预览继续生效。

## 工具映射

| MCP 名称 | 原业务动作/函数 | 首次调用参数 |
| --- | --- | --- |
| `bill_summary` | `handleBillSummary()` / `bill.summary` | `month`，YYYY-MM |
| `card_get` | `handleCard()` / `card.get` | `card_ref`，用户卡片称谓 |
| `transfer_preview` | `handleTransfer()` → `prepareTransferPreview()` / `transfer.create` | `source_account_ref`、`payee_ref`、`amount` |
| `card_budget_preview` | `handleCard()` → Core `prepare()` / `card.set_budget` | `card_ref`、`amount` |
| `card_freeze_preview` | `handleCard()` → Core `prepare()` / `card.freeze` | `card_ref` |
| `card_unfreeze_preview` | `handleCard()` → Core `prepare()` / `card.unfreeze` | `card_ref` |
| `subscription_list` | `dispatchBanking('subscription.list', ...)` | `{}` |
| `product_list` | `dispatchBanking('product.list', ...)` | `{}` |

`amount` 保留原 Skill 结构 `{ "amount_minor": 50000, "currency": "CNY" }`，整数分，不使用浮点元，不接受实体 ID 代替称谓。转账金额必须大于 0；卡片月预算允许 0–10,000,000 分。新工具名称只用于 MCP 适配，没有修改原 Skill 动作或参数。

卡片解析沿用已有规则：名称去除首尾空格后精确匹配；“我的卡”、未知称谓或重名会返回候选，不猜选一张。初始缺参也允许调用工具获得 `needs_clarification`；所有候选只暴露 `optionId` 和 `label`，实体映射留在加密续接凭据里。

`card_get`、预览工具和 HTTP 入口共用 `runBankingConversation()` 的候选生成、`resolveChoice()`、`verifyContinuationToken()`、`parseClarificationAnswer()`、`buildParsedIntent()` 和选择失效规则。MCP 续接凭据必须匹配当前工具动作，跨工具误用返回 `CONTINUATION_ACTION_MISMATCH`。旧 HTTP 入口的换任务流程保留。

订阅和产品通过服务器固定的只读动作调用现有 `dispatchBanking()`，返回实际 Repository 数据及来源、截至日期和条目 ID。未提供取消订阅、申购或赎回工具，也没有模型可传动作名的通用 dispatcher。

## 文件与依赖

- 新增 `server/mcp/saveflow-trial.mjs`：独立 Streamable HTTP MCP 服务。
- 新增 `server/banking-orchestrator.mjs`：从 HTTP 入口提取共享澄清与正式预览编排。
- 修改 `server/banking-agent.mjs`：传输层校验后调用共享编排。
- 更新 `tests/saveflow-trial.test.mjs`：通过真实 HTTP 和 MCP SDK 客户端验证工具、统计、输入拦截、业务异常、预览边界及 HTTP/MCP 续接一致性。
- 新增本说明 `docs/trueforge-trial.md`。
- 更新 `package.json`：启动/测试命令及依赖，并将 MCP 测试加入默认 `npm test`；`package-lock.json` 的依赖变更来自第一轮。

第一轮新增直接依赖 `@modelcontextprotocol/sdk`（1.32.1，使用兼容现有客户端的 v1 协议和 Streamable HTTP）及 `zod`（4.6.5，工具参数 schema 和额外字段校验）。使用官方 SDK 处理 MCP 握手、工具发现、调用与传输；HTTP 使用 Node 内置模块，无需直接添加 Express。原有依赖的锁定版本未改变；本轮扩展没有新增依赖。

## 启动

在 `saveflow-demo` 中执行，Node 要求沿用项目的 `>=22.12.0`：

```powershell
npm.cmd install
npm.cmd run mcp:trial
```

默认地址：`http://127.0.0.1:3333/mcp`。也可直接执行 `node server/mcp/saveflow-trial.mjs`。按 Ctrl+C 停止。

如需从 Docker 中的 TrueForge 访问 Windows 主机，或从其他主机访问，启动前指定监听地址：

```powershell
$env:SAVEFLOW_MCP_HOST = '0.0.0.0'
$env:SAVEFLOW_MCP_PORT = '3333'
npm.cmd run mcp:trial
```

服务为无会话 Streamable HTTP，POST `/mcp` 接收 MCP 请求并返回 JSON；GET/DELETE 返回 405。无需另行启动 Next.js 或配置模型密钥。

澄清凭据沿用 AES-256-GCM，默认有效期 5 分钟。MCP 在未配置 `CONTINUATION_TOKEN_SECRET` 时使用进程内随机密钥，重启会使之前的凭据失效。需要跨进程验证凭据时，在启动前配置相同的服务端密钥（至少 16 字符）；不要把密钥放入工具参数。HTTP 与 MCP 若要交叉续接，还必须使用相同的数据范围。本地默认各自持有独立 Mock Core，预览记录不会自动同步。

## 直接验证工具

自动验证不依赖 TrueForge，测试会使用临时端口启动并关闭服务：

```powershell
npm.cmd run test:mcp:trial
```

手动验证：保持服务运行，在 `saveflow-demo` 的另一个 PowerShell 终端执行。这个客户端会先完成 MCP 初始化，再发现和调用工具。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'saveflow-trial-check', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3333/mcp')));
  console.log(JSON.stringify(await client.listTools(), null, 2));
  for (const args of [{ month: '2026-08' }, {}, { month: '2026-13' }, { month: '2026-08', userId: 'OTHER' }]) {
    const result = await client.callTool({ name: 'bill_summary', arguments: args });
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await client.close();
}
'@ | node --input-type=module
```

预期：工具列表包含上表的 8 个工具，且没有 `action.decide`、`action.execute`；账单合法调用返回 `ok: true`，`data` 包含 `month`、`totalIncomeFen`、`totalExpenseFen`、`transactionCount` 和 `categoryTotals`；金额单位为 CNY 的分。2026-08 收入为 **1,200,000 分**，支出 **846,000 分**，共 **12 笔**，数据来源为 `synthetic_demo_only`，截至 `2026-09-01T00:00:00+08:00`。结果同时提供 JSON 文本及 `structuredContent`。

- `{}` 或不提供 arguments：`isError: true`，`kind: needs_clarification`，`missingSlots: ["month"]`，错误码 `MISSING_MONTH`。
- 非法字符串月份：`isError: true`，错误码 `INVALID_MONTH`；仅接受年份 0001–9999、月份 01–12 的严格 `YYYY-MM`，不接受空串或额外空格。
- 非字符串月份或任何额外字段（包括 `userId`、`user_id`）：SDK 输入校验工具错误。
- 上述无效输入均在读取账单前被拦截。
- Repository 或业务异常：`isError: true`，`kind: business_error`，错误码 `BILL_SUMMARY_FAILED`，包含错误信息，无伪造统计。
- 合法但没有交易的月份：返回实际的 0 收入、0 支出、0 笔和空交易证据，不回退到样例月份。

卡片与转账直接验证示例：服务运行后，在另一个 PowerShell 终端执行。续接只提交 `continuationToken` 配合 `choice` 或 `message` 二选一，不能同时提交初始参数覆盖凭据中的草稿。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
@'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'saveflow-preview-check', version: '0.2.0' });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const output = result.structuredContent ?? result.content;
  console.log(JSON.stringify({ name, output }, null, 2));
  return output;
};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3333/mcp')));
  await call('card_get', { card_ref: '娱乐虚拟卡' });
  const draft = await call('transfer_preview', { payee_ref: '王先生', amount: { amount_minor: 50000, currency: 'CNY' } });
  const payees = await call('transfer_preview', { continuationToken: draft.continuationToken, choice: { optionId: draft.choices[0].optionId } });
  await call('transfer_preview', { continuationToken: payees.continuationToken, choice: { optionId: payees.choices[1].optionId } });
  await call('card_budget_preview', { card_ref: '娱乐虚拟卡', amount: { amount_minor: 10000, currency: 'CNY' } });
  await call('card_freeze_preview', { card_ref: '娱乐虚拟卡' });
  await call('card_unfreeze_preview', { card_ref: '娱乐虚拟卡' });
  await call('subscription_list');
  await call('product_list');
} finally {
  await client.close();
}
'@ | node --input-type=module
```

预期：查询返回真实卡片；转账先选账户、再选重名收款人，最终返回 50,000 分的正式预览；预算和冻结仅返回预览。原 Mock 卡片均为 active，因此解冻调用应返回 `INVALID_STATE`，不能因为先前生成过冻结预览就假设卡片已被冻结；测试使用内存中的 frozen 卡片样例另行验证解冻成功预览。缺参和未识别回答返回 `ok: true, kind: needs_clarification`；业务和输入错误返回 MCP `isError: true`，保留明确错误码。

验证覆盖：本轮先通过卡片查询和转账预览的 10 项 MCP 测试，再扩展工具；最终 MCP 测试 15 项通过，既有项目测试通过 114 项、2 项 PostgreSQL 测试按环境条件跳过。测试包括同名卡、重名收款人、自然语言补参、预览改口、伪造/过期/跨工具凭据、注入授权字段、余额不足、预算范围和预览不执行。

## TrueForge 连接配置

根据 [TrueForge 官方 MCP 连接说明](https://github.com/truefoundry/trueforge/blob/main/docs/mcp-servers.mdx)，进入 **Settings → Connectors → Add MCP Server**，填写：

| 配置 | 值 |
| --- | --- |
| Name | `saveflow-trial` |
| Server URL | `http://127.0.0.1:3333/mcp`（TrueForge 后端与服务同机） |
| Transport（若有选择项） | `Streamable HTTP` |
| Authentication | `No auth` |
| Headers | 留空 |

地址必须是 **TrueForge 后端可访问**的地址。若 TrueForge 后端运行在 Docker Desktop，启动 MCP 时使用 `SAVEFLOW_MCP_HOST=0.0.0.0`，URL 填 `http://host.docker.internal:3333/mcp`；其他主机或托管实例则使用实际可达的主机地址或代理 URL，并保留 `/mcp` 路径。仅浏览器与服务同机不足以保证后端可访问。

保存后，在 TrueForge 的试点 Agent 中选择该 connector，重新连接以刷新工具列表，确认发现上表的 8 个工具且没有确认/执行工具。发送“查询 2026 年 8 月账单”，预期工具参数为 `{"month":"2026-08"}`；只说“查账单”时应由 Agent 询问月份，若工具收到缺月调用也会返回明确缺参结果。卡片或转账需要澄清时，Agent 向用户展示候选/问题，并在同名工具内传回原凭据与用户回答；返回预览后明确告知尚未执行。连接表单不填写 command/args；本实现提供 HTTP URL。

本地已验证 MCP 协议及业务调用；本次未启动或修改 TrueForge 实例，实际 connector 连接和 Agent 调用需在该实例中验证。
