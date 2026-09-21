# SaveFlow Demo

已增加 **Qwen 真实自然语言模型接入**：服务端密钥、JSON 意图与参数解析、多轮追问、模拟账单解释、待确认计划、Token 使用展示。详见 [Qwen 接入与部署](docs/Qwen接入与部署.md)。本地配置 `.env.local` 后运行 `npm run dev:qwen`；`npm run dev` 仅启动前端。真实模型调用需自行配置百炼密钥，资金操作仍为模拟。

部署 Qwen 版本到原 Netlify 站点，需要同时部署 `netlify/functions`；下文拖拽 `out` 的方式只适用于离线模拟，不包含模型服务。

已接入前端状态机及可切换的 Mock / HTTP 接口层。默认使用浏览器内合成数据，静态部署也能运行；“确认创建计划”与支付分离，支持明确确认、防重复提交及超时结果查询。

配置示例见 [`.env.example`](.env.example)，状态流转、接口契约、联调方式及接入边界见 [状态机与接口配置](docs/状态机与接口配置.md)。这些为 SaveFlow 设计约定，不是微众银行官方技术规范或真实银行接入。

校验命令：`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。

## 本机打开

```bash
npm install
npm run dev
```

打开 <http://localhost:3000>。

## 部署到 Netlify

不要只上传 `src`。Netlify 需要完整的 `saveflow-demo` 项目目录，其中包括 `package.json`、`package-lock.json`、`next.config.ts` 和 `src`。

本项目已配置为静态导出。部署方式有两种：

### 方式一：Netlify 连接 Git 仓库

将整个 `saveflow-demo` 目录作为仓库内容推送，然后在 Netlify 设置：

- Base directory：留空（如果仓库根目录就是 `saveflow-demo`）
- Build command：`npm run build`
- Publish directory：`out`

仓库中的 `netlify.toml` 会自动提供这些设置。

### 方式二：Netlify Drop 直接上传

在本机执行：

```bash
npm install
npm run build
```

构建完成后，把生成的 `out` 文件夹拖到 Netlify Drop。不要拖 `src` 文件夹，也不要拖整个项目作为静态文件发布。

## 让同一局域网的队友打开

在本机运行：

```bash
npm run dev:network
```

然后把本机局域网 IPv4 地址发给队友，例如：

```text
http://192.168.1.23:3000
```

Windows 查看 IPv4 地址：

```powershell
ipconfig
```

队友和本机需要连接同一个 Wi-Fi 或局域网。首次运行时，如果 Windows 防火墙询问是否允许 Node.js 通信，请允许“专用网络”。

## 访问页面

- IM 演示：`http://<本机IP>:3000/`
- 卡片调试页：`http://<本机IP>:3000/card-debug`

这是临时演示服务器。关闭终端后页面就不可访问；队友不需要安装依赖，只需要浏览器。

## 不在同一局域网

可以使用 Cloudflare Tunnel、ngrok 或部署到 Vercel。此时不要把开发服务器直接暴露到公网，尤其不要把真实账户数据放进演示环境。
