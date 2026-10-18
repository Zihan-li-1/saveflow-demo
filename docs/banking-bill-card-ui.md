# BankingBillCard 展示优化

日期：2026-10-14；分支：`spike/trueforge-harness`。

## 修改范围

- `src/app/page.tsx`：导入独立组件，移除原内联账单组件；props 和请求链不变。
- `src/app/BankingBillCard.tsx`：月份标题、大号总支出、绿/橙红收支区域、结余、总交易笔数、分类金额及来源日期。
- `src/app/banking-bill-card.css`：账单专属样式；桌面双列，窄屏单列，数字支持换行。保留整站浅色蓝色风格。
- `src/lib/bill-display.ts`：整数分展示、年月、北京时间日期、分类完整性检查。
- `tests/banking-bill-card.test.cjs`、`package.json`：五项组件/展示测试加入默认测试命令，没有增加项目依赖。
- `scripts/verify-banking-bill-ui.mjs`：真实原页面浏览器验收和截图；极端金额使用独立、明确标注的 HTTP 展示 fixture。
- `scripts/verify-trueforge-ui.mjs`：仅更新账单展示断言，匹配新格式。
- 本文及 `docs/verification/bill-card/`：验收记录和前后截图。

未修改本轮开始时已有的服务端、访问码配置、TrueForge、MCP、Core、统计函数、请求协议、其他 Skill 卡片或依赖锁文件。没有提交 Git、创建 PR 或合并。

## 数据来源

月份、收入、支出、总交易笔数、分类金额、来源及截至日期来自现有结构化响应。前端唯一派生财务指标是收支结余（收入整数分减支出整数分），明确标注不是账户可用余额。金额展示采用整数分的整数/余数拆分，避免大金额浮点转换造成分位误差。未知/非法字段显示“—”或未知状态，不从模型文字提取金额。

分类只在金额均为非负安全整数、非空且合计等于总支出时展示，按金额排序；不展示虚构比例。缺失、不完整或零支出的分类不渲染。日期统一转换至 `Asia/Shanghai`，明确显示北京时间。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新增组件测试 | 5 项通过：样例、零值/缺分类、极端金额/负结余、时区日期、分类/不读取模型文字 |
| 全量 npm test | 157 项，155 通过，0 失败，2 项 PostgreSQL 按环境条件跳过 |
| lint / typecheck | 通过；typecheck 使用 `--incremental false` |
| 本轮修改文件 diff 检查 | 通过；工作区已有的 Next 生成文件改动保留 |
| 真实本地原页面 | 2026-08 收入 ¥12,000.00、支出 ¥8,460.00、结余 +¥3,540.00、总交易 12 笔 |
| 真实澄清 | “查账单” → NEEDS_CLARIFICATION → “2026 年 8 月” → 原账单卡片 |
| 真实零交易月份 | 2026-01 四处金额为 ¥0.00，总交易 0 笔，无分类区 |
| 桌面与手机 | 1440px、390px、320px 的账单内容无横向溢出 |
| 长金额展示 fixture | 320px 下安全整数最大金额不丢分、不溢出；无分类数据时不渲染分类 |

截图前清空访问码输入框；报告不保存请求 Header、访问码、密钥或 Session 凭据。为完整展示聊天滚动区内的长卡片，截图保留设备宽度并增加捕获高度，随后恢复原视口；溢出断言在原视口执行。

## 截图

- [原卡片 / 桌面原页面](verification/bill-card/before-desktop-page.png)
- [新卡片 / 桌面原页面](verification/bill-card/after-desktop-page.png)
- [新卡片 / 手机完整卡片](verification/bill-card/after-mobile-card.png)
- [零交易卡片](verification/bill-card/after-zero-card.png)
- [超长金额 / 手机展示 fixture](verification/bill-card/fixture-long-mobile-card.png)
- [浏览器验收记录](verification/bill-card/after-report.json)

Playwright 安装在独立临时工具目录，没有改项目依赖。复跑时指定自己的 Playwright 模块路径后执行 `node scripts/verify-banking-bill-ui.mjs`；脚本通过 Next 的本地环境加载器取得认证配置，仅在内存中用于原页面验证。尚未执行 Netlify 部署验证。
