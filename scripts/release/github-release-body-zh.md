# Waypoint v0.6.0

## 新功能

### 🛠️ 内置 MCP 服务
Waypoint 现在在 `POST /mcp` 提供第一方 MCP 服务器（仅限 localhost），包含两个强大工具：

- **`generate_image`** - 直接从聊天生成图像，采用文件优先输出策略。图像始终写入工作区并返回相对路径。
- **`understand_image`** - 使用视觉模型分析图像，保留原始几何信息以支持坐标敏感任务。

### 🤖 代理模式
在 Playground 中切换代理模式以启用工具调用工作流。从选择器中选择工具，代理将在对话中自动使用它们（每条消息最多 10 次迭代）。

### 📊 Token 流向桑基图
Peek 中的新可视化显示 token 的流向 - 输入与输出，按模型归类。用可视化清晰度调试 token 使用。

## 核心特性

- **OpenAI 兼容代理** - `localhost:8000/v1` 路由到多个后端
- **健康状态故障转移** - 自动重试和熔断器
- **Provider 优先架构** - `waypoint providers import -f .env`
- **实时仪表板** - 延迟、token、错误、每模型统计
- **Peek 请求检查器** - 日历浏览器 + 时间线 + 桑基图

## 破坏性变更

无。这是一个功能发布。

## 迁移

无需迁移。现有配置可直接使用。

## 截图

### 带有 MCP 工具的代理模式
![MCP 图像生成](https://github.com/zziang/waypoint/blob/dev/assets/mcp-generate-image.png?raw=true)

### 图像理解
![MCP 图像理解](https://github.com/zziang/waypoint/blob/dev/assets/mcp-understand-image.png?raw=true)

### Token 流向桑基图
![Peek Token 流向](https://github.com/zziang/waypoint/blob/dev/assets/peek-token-flow.png?raw=true)

## 安装

```bash
git clone https://github.com/zziang/waypoint
cd waypoint
npm install
cd ui && npm install && cd ..
npm run build:all
npm run start
```

访问 `http://localhost:8000/ui`

## 链接

- [文档](https://github.com/zziang/waypoint#readme)
- [MCP 服务指南](https://github.com/zziang/waypoint/blob/main/docs/mcp-service.md)
- [MCP 准则](https://github.com/zziang/waypoint/blob/main/docs/mcp-guidelines.md)

---

为本地 AI 社区用心构建 ❤️
