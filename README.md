# SaveFlow Demo

对应公共网址：https://startling-flan-ed8dcb.netlify.app/

已完成 B 项目 Banking Core：公共类型、统一 FinancialContextRepository、Mock 转账预览/风险/确认/幂等执行/回执、HTTP 及旧接口适配。交接规范见 [Banking Core 合同与验收](docs/Banking-Core.md)。本次修改未发布到上述网址。

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

验收脚本模拟张三 500 元转账并核验幂等，不调用真实 Qwen 或银行。自然语言转账路由和聊天确认卡属于 A/D 后续对接范围。
