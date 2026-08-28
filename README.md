# NodeLoc Auto Scroll

NodeLoc 自动滚动与有依据的人工确认回帖 Tampermonkey 用户脚本。

## 功能

- 在 NodeLoc 帖子页面自动滚动浏览
- 支持随机速度和匀速模式
- 支持滚动暂停、恢复、跳过当前帖子和自动进入下一篇
- 记录最近 200 篇已读帖子，避免重复浏览
- 提供回复上下文筛选和候选质量校验
- 可选接入兼容 Anthropic 或 OpenAI 风格接口的模型
- 保存完整请求日志，并支持在面板中复制
- 监听 NodeLoc 单页应用路由变化

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开本仓库中的 `nodeloc_auto_scroll_v20.user.js`。
3. 在 Tampermonkey 中新建脚本，将文件内容粘贴进去并保存；也可以直接使用 Tampermonkey 的导入功能。
4. 打开 [NodeLoc](https://www.nodeloc.com/)，进入帖子页面即可看到脚本面板。

## 使用

- `P`：暂停或恢复自动滚动
- `S`：停止当前滚动并尝试进入下一篇
- 面板中的“跳过”按钮：停止当前帖子并进入下一篇
- 在 AI 配置区域填写接口地址、模型名称和 API Key 后，可启用 AI 辅助回复候选生成

脚本默认只在 `https://www.nodeloc.com/*` 页面运行。

## 配置说明

脚本通过 Tampermonkey 的 `GM_getValue` / `GM_setValue` 保存配置，包括滚动速度、停留时间、自动进入下一篇、接口地址、模型名称和 API Key。

API Key 只保存在浏览器本地脚本存储中。请勿把包含真实密钥的日志、截图或导出内容提交到公开仓库。

## 权限

脚本声明了以下 Tampermonkey 权限：

- `GM_setValue` / `GM_getValue`：保存配置和已读记录
- `GM_setClipboard`：复制日志和文本
- `GM_xmlhttpRequest`：向配置的 AI 接口发起请求
- `@connect *`：允许访问用户配置的接口域名

启用 AI 请求前，请确认接口服务商、数据处理方式和费用符合你的预期。

## 免责声明

本脚本仅供个人学习和自动化研究使用。请遵守 NodeLoc、Tampermonkey 以及所使用 AI 服务的条款，不要发送骚扰内容或绕过网站的访问限制。使用前请自行检查脚本行为和第三方服务风险。
