# Qwen 接入与部署

SaveFlow 已增加真实模型接口。默认模型为北京地域 `qwen-plus`，非思考模式、JSON 输出、单次最多1000个输出 Token。**模型推理可以是真实的，账单和资金操作仍为模拟**。本次交付不包含真实银行、支付或账户连接。

## 本地启动

需要 Node.js >=22.12。在 `saveflow-demo` 目录执行：

```powershell
# 如已有 .env.local，请手动补充字段，不要覆盖原文件。
Copy-Item .env.example .env.local
npm run dev:qwen
```

启动前用编辑器填写 `.env.local`（已被 Git 忽略）：

```dotenv
NEXT_PUBLIC_SAVEFLOW_API_MODE=mock
DASHSCOPE_API_KEY=你的北京地域百炼密钥
QWEN_MODEL=qwen-plus
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
SAVEFLOW_ACCESS_CODE=自己设置的至少16位演示访问码
```

`DASHSCOPE_API_KEY` 只交给后端。`SAVEFLOW_ACCESS_CODE` 是另外设置的私人演示口令，在网页输入；它不等于百炼密钥。二者都不能加 `NEXT_PUBLIC_` 前缀，不能提交到仓库。演示访问码只保存在页面内存，刷新后需重输。

打开终端提示的 `http://127.0.0.1:3000`，选择“Qwen 真实模型”，输入演示访问码，勾选发送对话和模拟账单摘要的授权，再提问。修改环境变量后重启服务。普通 `npm run dev` 仍仅启动前端；只有 `npm run dev:qwen` 同时启动模型接口。

可测试：

- “我想每月存2000元，日常消费自动存5%。” → 返回待确认计划。
- “我想存2万元。” → 信息不足时询问期限或月金额；可继续回答“分12个月”。
- “餐饮储蓄规则设为5%。” → 提取餐饮和比例，月金额沿用演示默认2500元并明确显示。
- “帮我分析账单。” → 用服务端模拟摘要回答，不创建计划。
- “找出闲置订阅。” → 仅能解释当前模拟摘要，不捏造订阅使用情况。

选择“离线模拟”不会调用模型。Qwen 模式缺密钥、访问码不正确、接口未部署、超时、额度不足或格式错误均明确显示错误，不静默回退模拟。重试由用户主动触发；重复提问可能重复计费。

## 更新现有 Netlify 网址

**只拖拽 `out` 或旧的静态部署 ZIP 不会部署模型后端。** 保留原站点 `startling-flan-ed8dcb`，使用以下任一种方式部署完整项目。

Banking Core 已新增独立的模拟接口与确认流程，说明见 [Banking Core](Banking-Core.md)。默认离线业务模式保持不变，模型不会自动确认转账。

### 方式一：原站点连接 Git 仓库

1. 将项目推送到自己的仓库（排除 `.env.local`、密钥、node_modules）。
2. 在现有 Netlify 项目的构建设置里连接该仓库，不新建站点。
3. 如果仓库根目录就是项目目录，Base directory 留空；否则填 `saveflow-demo`。
4. Build command 为 `npm run build`，Publish directory 为 `out`。仓库中的 `netlify.toml` 已配置 `netlify/functions` 为函数目录。
5. 在项目 Environment variables 中增加 `DASHSCOPE_API_KEY`、`QWEN_MODEL`、`QWEN_BASE_URL`、`SAVEFLOW_ACCESS_CODE`，确保对 **Functions 运行时和 Production 部署**生效。业务接口模式保持默认 `mock`。
6. 触发部署，在部署结果中确认有 `agent` Function，查看日志确认限流规则成功生效。打开原网址，选择 Qwen、输入演示访问码并提问。

### 方式二：Netlify CLI 发布到原站点

本机安装并登录官方 Netlify CLI 后，在项目目录执行：

```powershell
netlify login
netlify link
# 交互选择已有的 startling-flan-ed8dcb 站点，不能选择新建。
npm run build
netlify deploy --prod --dir=out --functions=netlify/functions
```

部署前同样必须在该站点后台配置运行时环境变量；本地 `.env.local` 不会自动成为线上函数环境变量。部署需要有该站点权限的登录账号。本次尚未取得该站点部署连接，因此不会声称线上已更新。

## 实现和边界

```text
浏览器 /api/agent
→ 本地自定义开发服务 / Netlify Function
→ 访问码、来源、请求大小、授权与字段检查
→ 北京地域 Qwen 兼容接口（服务端持有密钥）
→ JSON 结构与业务约束校验
→ 前端追问 / 回答 / 待确认计划
→ 用户确认后调用已有模拟业务接口
```

- `server/qwen.mjs`：共享服务端处理器，固定支持北京地域官方域名；客户端不能指定模型地址、系统提示词或供应商密钥。仅发送模拟汇总，不发送原始账单文件。
- `netlify/functions/agent.mjs`：生产 Function，映射 `/api/agent`，配置每 IP/域名每60秒10次的限流。部署日志必须确认规则生效；平台限流不是严格的全局费用封顶。
- `scripts/dev-qwen.mjs`：本地同源服务，监听回环地址，同时启动 Next、`/api/agent`、`/api/banking` 和旧 POST `/api/saveflow`，本地每分钟最多10次请求。
- `src/lib/agent-client.ts`：前端调用和响应校验。消息上限500字，最多保留最近6条成功对话，上下文只在内存保留。
- `src/lib/use-saveflow.ts`、`flow-machine.ts`：支持“等待补充信息”和“已回答”状态；回答类意图不会直接跳到计划确认。
- 每个请求只调用一次模型；服务端25秒超时，客户端30秒超时；不自动重试。即使超时，供应商已经处理的请求仍可能收费。
- 页面显示最近一次输入/输出 Token。没有 usage 时显示0只是缺少计数，不代表免费；最终金额以百炼账单为准。
- 数值上限、每月储蓄计算和现金流检查由程序执行，模型输出不能直接触发支付。模型提供的用户意图和参数仍可能有误，必须由用户核对确认。
- “目标总额”按公共仓库的目标进度计算剩余差额，当前种子为0元；月份为演示计算口径，包含当前月。未指定比例时为0，不自动推断比例。当前草稿不保存正式到期日期，也不保证达到目标。
- 模拟计划仍不具备服务端持久化和跨设备状态恢复；修改规则不等于银行规则已修改。
- 演示访问码用于限制私人演示使用，不替代生产身份认证。多人公开上线需接入登录、用户级额度和持久化限流/账务日志。付费限额应在供应商可用的额度控制和应用预算服务中落实，不能把单 IP 限流当成总预算。

自动化测试使用假的供应商响应，不产生模型费用，也不能替代真实账号联调。完成环境变量后，首次用一条合成指令验证返回和 Token，再逐步扩大测试。

## 官方资料

- [阿里云兼容接口与地域说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)：北京旧域名仍可用，也可将 `QWEN_BASE_URL` 改成业务空间专属 `https://业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；密钥必须与地域匹配。
- [创建 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)
- [Qwen Plus 能力及价格](https://help.aliyun.com/zh/model-studio/qwen-plus)
- [Netlify Functions 入门](https://docs.netlify.com/build/functions/get-started/)
- [Netlify 限流规则](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/)
