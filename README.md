# SaveFlow Demo

对应公共网址：https://startling-flan-ed8dcb.netlify.app/

已完成 B 项目 Banking Core：公共类型、统一 FinancialContextRepository，以及转账、卡片调额、模拟代扣解除、合成理财申购共用的预览/风险/确认/幂等执行/回执流程；PostgreSQL 持久层将业务变更与回执放在同一事务中。所有数据和资金效果均为合成 Mock，不连接真实银行。本地代码尚未发布到上述网址。交接规范见 [Banking Core 合同与验收](docs/Banking-Core.md)。

```bash
npm install
npm run dev:qwen
```

`dev:qwen` 同时启动前端及本地模型/Banking Core API；需要 Node >=22.12，访问码配置见 [Qwen 接入](docs/Qwen接入与部署.md)。默认业务为离线 Mock，资金操作均为合成数据。

```bash
npm run demo:banking
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run demo:banking` 模拟张三 500 元转账并核验幂等，不调用真实 Qwen 或银行。Banking Agent 自然语言入口与聊天确认卡仍属于 A/D 集成范围；新增 B HTTP 动作暂由 typed client 调用。

PostgreSQL 跨实例验收需先在专用数据库运行 `npm run db:migrate`，再设置 `BANKING_TEST_DATABASE_URL` 并执行 `npm test`。没有该变量时 Postgres 集成测试会显示为 skipped，不能视为跨实例验收通过。
