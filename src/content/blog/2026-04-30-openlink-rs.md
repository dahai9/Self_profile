---
title: '用 Rust 为网页 AI 搭建本地桥梁：openlink-rs 技术剖析'
description: 'openlink-rs 是一个基于 Rust (Axum + Tokio) 的本地代理服务，配合浏览器扩展让 ChatGPT、Gemini 等网页 AI 直接操作本地文件系统。本文从架构设计、安全模型、工具系统到浏览器扩展的流式拦截，完整拆解这个项目的技术实现。'
pubDate: 'Apr 30 2026'
---

> **摘要**：网页版 AI（ChatGPT、Gemini、AI Studio）能力强大，但无法触及用户的本地文件系统。openlink-rs 通过一个本地 Rust 服务 + 浏览器扩展的组合，在 AI 网页和本地文件系统之间架起了一座桥梁。本文剖析其整体架构、核心模块、安全模型以及浏览器扩展的流式响应拦截技术。

---

## 1. 起因：网页 AI 的边界

当前主流的 AI Agent 框架（Claude Code、Cursor、Codex 等）都能直接操作本地文件系统。但这些工具要么依赖 API 调用，要么需要专用客户端。而大部分用户日常使用的 ChatGPT、Gemini 等网页版 AI，运行在浏览器沙箱中，无法访问本地资源。

openlink-rs 的思路是：**不需要 API，不需要专用客户端，让网页 AI 通过"输出工具调用 → 浏览器拦截 → 本地执行 → 结果回注"的循环来操作本地文件系统**。

项目是原 [openlink](https://github.com/afumu/openlink)（Go 实现）的 Rust 重写版本，在原项目基础上进行了架构重构，并新增了 Firefox 兼容和 ChatGPT 支持。

---

## 2. 整体架构

openlink-rs 由两个组件构成：

```
┌─────────────────────────────────────────────────┐
│  Browser (Chrome / Firefox)                      │
│                                                  │
│  AI 网页 (ChatGPT / Gemini / AI Studio)          │
│    │  输出 YAML tool_call 代码块                  │
│    ▼                                             │
│  Content Script ──→ MutationObserver 检测        │
│    │  渲染工具卡片 UI                             │
│    │  用户点击执行                                │
│    ▼                                             │
│  Background Worker ──→ HTTP POST localhost:39527 │
│                                                  │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│  Rust Server (Axum + Tokio)                      │
│                                                  │
│  Auth Middleware ──→ Bearer Token 验证            │
│    │                                             │
│    ▼                                             │
│  Executor ──→ 工具名匹配 → validate() → execute() │
│    │                                             │
│    ▼                                             │
│  Tool (exec_cmd / read_file / edit / ...)        │
│    │                                             │
│    ▼                                             │
│  Security Sandbox ──→ 路径校验 + 命令过滤        │
│    │                                             │
│    ▼                                             │
│  Local Filesystem                                │
└──────────────────────────────────────────────────┘
```

核心协议是 **YAML `tool_call` 代码块**。AI 模型在对话输出中生成包含 `tool_call` 的 YAML 代码块，浏览器扩展检测到后执行对应工具，再将结果以 `tool_result` 格式回注到对话中。整个过程不需要任何 API key 或平台专属集成。

---

## 3. Rust 后端：Axum + Tokio

### 3.1 入口与 CLI

使用 `clap` 解析三个参数：

- `--dir`：工作目录（沙箱根目录，默认当前目录）
- `--port`：监听端口（默认 `39527`，绑定 `127.0.0.1`）
- `--timeout`：命令超时秒数（默认 60）

启动时加载或生成认证 Token（32 字节随机 hex，持久化到 `~/.openlink/settings.json`），构建 `Executor`，组装 Axum Router。

### 3.2 HTTP 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（免认证） |
| POST | `/auth` | Token 验证（免认证） |
| GET | `/config` | 返回 rootDir 和 timeout |
| GET | `/tools` | 列出所有已注册工具及参数定义 |
| POST | `/exec` | **核心端点** — 执行工具调用 |
| GET | `/prompt` | 返回注入系统信息的初始化提示词 |
| GET | `/skills` | 列出可用 Skills |
| GET | `/files?q=` | 目录文件搜索（最多 50 条） |

所有端点（除 `/health` 和 `/auth`）都需要 `Authorization: Bearer <token>` 认证。

### 3.3 工具调度引擎

`Executor` 持有一个 `Registry`（`HashMap<String, Arc<dyn Tool>>`）和一个 `AtomicU64` 调用计数器。执行流程：

```
ToolRequest
  → 按名称查找工具（精确匹配 → 小写降级）
  → tool.validate(args)
  → tool.execute(ctx)
  → 注入身份强化提醒（每 20 次调用重新注入完整 init_prompt）
  → ToolResponse
```

**身份强化**机制是一个有趣的设计：AI 模型在长对话中会"忘记"自己的角色和工具调用约定。每隔 20 次工具调用，系统会在响应中追加完整的初始化提示词；每次调用则追加一行简短提醒。这有效防止了模型在长会话中的角色漂移。

### 3.4 工具系统

项目实现了 11 个工具，通过统一的 `Tool` trait 组织：

```rust
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> Value;
    fn validate(&self, args: &HashMap<String, Value>) -> Result<(), String>;
    fn execute(&self, ctx: &ToolContext) -> ToolResult;
}
```

| 工具 | 用途 | 技术要点 |
|------|------|----------|
| `exec_cmd` | Shell 命令执行 | Unix 下 `sh -c`，在 `block_in_place` 中执行，50ms 轮询 `try_wait` 实现超时 |
| `read_file` | 文件读取 | 基于行的 offset/limit 分页，单次最大 2000 行或 50KB |
| `write_file` | 文件写入 | 支持覆盖/追加，自动创建父目录，Unix 下设置 0o644 权限 |
| `edit` | 精确字符串替换 | **最复杂的工具** — 10 种级联替换策略 + Levenshtein 距离模糊匹配 |
| `list_dir` | 目录列出 | 目录名追加 `/` 后缀 |
| `glob` | 文件名模式搜索 | `globset` 匹配，按 mtime 降序排列，限制 100 条 |
| `grep` | 正则内容搜索 | 优先使用 ripgrep，否则回退到 Rust 原生实现 |
| `web_fetch` | HTTP 内容获取 | SSRF 防护、30s 超时、1MB 体限制 |
| `question` | 用户交互 | 带可选选项的提问弹窗 |
| `skill` | 加载 Skills | 从 `.skills/` 目录加载 Markdown 文件 |
| `todo_write` | 待办持久化 | 写入 `.todos.json` |

---

## 4. 编辑工具：10 种级联替换策略

`edit` 工具是整个项目中技术含量最高的部分。AI 模型生成的"旧文本"与文件中的实际内容经常存在各种差异：尾部空格、缩进变化、转义序列、Tab/换行混淆等。如果只做精确匹配，编辑成功率会很低。

`edit` 工具实现了 10 种级联的替换策略，从精确到宽松依次尝试：

1. **Simple** — 精确字符串匹配
2. **Line-trimmed** — 忽略行首尾空格
3. **Block-anchor** — 基于首尾行锚定匹配
4. **Whitespace-normalized** — 将连续空白压缩为单空格
5. **Indentation-flexible** — 忽略整体缩进差异
6. **Escape-normalized** — 统一转义序列（`\t`、`\n` 等）
7. **Trimmed-boundary** — 裁剪边界空白
8. **Tab-newline** — Tab 与空格互换
9. **Context-aware** — 基于上下文行定位
10. **Multi-occurrence** — 多处匹配检查（防止歧义编辑）

最后还有一层 **Levenshtein 距离**模糊匹配兜底。这种设计大幅提升了 AI 驱动代码编辑的成功率。

---

## 5. 安全模型

### 5.1 沙箱隔离

所有文件操作限制在 `root_dir` 内。路径验证通过 `canonicalize()` 解析符号链接并做前缀检查：

```rust
// 伪代码
fn safe_path(user_path, root_dir) -> Result<PathBuf> {
    let resolved = root_dir.join(user_path).canonicalize()?;
    if !resolved.starts_with(root_dir) {
        return Err("path traversal blocked");
    }
    Ok(resolved)
}
```

绝对路径和 `~` 路径则验证是否在白名单根目录内（`root_dir`、`~/.claude`、`~/.openlink`、`~/.agent`）。

### 5.2 危险命令拦截

`is_dangerous_command()` 在命令执行前进行检查：

- **多词模式匹配**：`rm -rf`、`chmod 777`、`kill -9`、`> /dev/`
- **单词边界匹配**：`mkfs`、`format`、`sudo`、`reboot`、`shutdown`
- **明确放行**：`curl` 和 `wget` 允许使用

### 5.3 SSRF 防护

`web_fetch` 工具在发起 HTTP 请求前先通过 `getent` 解析 DNS，然后检查目标 IP 是否属于私有/内网地址段（`10.x`、`172.16-31.x`、`192.168.x`、`127.x`、`169.254.x`、IPv6 link-local/ULA），防止 AI 通过 web 访问本地网络服务。

### 5.4 Token 认证

64 字符的 hex Token 在首次运行时生成，持久化到 `~/.openlink/settings.json`（`0o600` 权限）。认证中间件使用**常时间比较**（XOR + fold）防止时序攻击。

---

## 6. Skills 系统

Skills 是 Markdown 文件形式的插件扩展，AI 可按需加载。系统按优先级扫描 7 个目录：

```
<rootDir>/.skills/
<rootDir>/.openlink/skills/
<rootDir>/.agent/skills/
<rootDir>/.claude/skills/
~/.openlink/skills/
~/.agent/skills/
~/.claude/skills/
```

每个 Skill 是一个子目录，包含带 YAML frontmatter 的 `SKILL.md`：

```markdown
---
name: deploy
description: 项目部署流程
---

## 部署步骤
...
```

同名 Skill 以先找到的为准。Skill 名称中的路径分隔符（`/`、`\`、`..`）会被拒绝，防止路径穿越。这种设计让 Skills 可以与 Claude Code 等工具共享目录结构。

---

## 7. 浏览器扩展

### 7.1 工具调用提取器

`toolcall.ts` 是一个从零实现的多格式解析器，支持三种 AI 输出格式：

- **YAML**（主格式）：完整的递归 YAML 解析器，支持 block scalar（`|`、`>`）、嵌套映射和列表
- **XML**：解析 `<tool name="..." call_id="...">` + `<parameter>` 子元素
- **JSON**：标准 JSON，带回退修复未转义引号的兼容逻辑

解析器还会剥离 Markdown 代码围栏、规范化 HTML 实体、并基于 `name:callId` 键去重。

### 7.2 流式响应拦截

扩展通过 Monkey-patch `window.fetch` 来拦截 AI 平台的流式响应。在页面上下文中注入的脚本逐块解码响应文本，当检测到完整的代码围栏或 XML 元素时，通过 `window.postMessage` 发出工具调用事件。

每个会话的去重基于从 URL 路径提取的对话 ID（`/chat/<id>`、`/c/<id>` 或 `?id=<id>`），使用内存 Set + localStorage（7 天 TTL）。

### 7.3 Content Script

主逻辑在 `content/index.ts`（约 1000 行），核心功能：

**站点适配**：通过 `getSiteConfig()` 返回各平台的 CSS 选择器和文本插入方式：

| 平台 | 编辑器选择器 | 插入方式 |
|------|-------------|----------|
| Gemini | `div.ql-editor[contenteditable]` | `execCommand` |
| ChatGPT | `#prompt-textarea.ProseMirror` | ProseMirror 兼容插入 |
| AI Studio | `textarea[placeholder*="Start typing"]` | 原生 value setter |

**DOM Observer**：`MutationObserver` 监听新生成的 AI 回复元素，800ms 防抖 + 3s 最大等待时间处理流式文本。文本提取时跳过 UI 噪声标签（`MAT-ICON`、`SCRIPT`、`STYLE`、`BUTTON` 等）。

**工具卡片 UI**：检测到工具调用后渲染深色主题卡片，包含工具名、参数、执行/跳过按钮、结果展示和"插入对话"按钮。

**自动发送倒计时**：注入工具结果后显示 1-4 秒随机倒计时 toast，然后自动点击发送按钮。用户可随时取消。

**快捷补全**：
- 输入 `/` 触发 Skills 补全（`GET /skills`）
- 输入 `@` 触发文件路径补全（`GET /files?q=`）
- 支持 ↑/↓ 键盘导航、Enter 确认、Escape 关闭

### 7.4 Background Service Worker

Manifest V3 下 Content Script 无法直接发起跨域请求。Background Worker 作为代理中转 Content Script 的 `FETCH` 消息到实际的 `fetch()` 调用，返回 `{ ok, status, body }`。

### 7.5 构建系统

使用 Vite + esbuild，Content Script 和 Injected Script 以 IIFE 格式打包（无模块系统），Background Worker 通过 Rollup 打包。通过 `--mode` 切换 Chrome/Firefox 构建模式，选择对应的 manifest 文件。

---

## 8. 关键设计决策总结

| 决策 | 理由 |
|------|------|
| YAML 作为通信协议 | 人类可读、支持多行文本（block scalar）、对格式错误容错性好 |
| 流式拦截而非 API 集成 | 无需 API key，跨平台通用，ChatGPT/Gemini/AI Studio 一套代码 |
| 10 种级联编辑策略 | AI 生成的文本与文件内容经常存在空白/缩进/转义差异，精确匹配成功率低 |
| 身份强化机制 | 防止 AI 在长对话中"忘记"角色和工具调用约定 |
| 常时间 Token 比较 | 防止时针攻击泄露 Token |
| SSRF 防护 | 防止 AI 通过 web_fetch 访问内网服务 |
| 手动确认执行 | 用户对每次工具调用有完全控制权，避免 AI 误操作 |

---

## 9. 经验与反思

### Rust 在这个场景的优势

- **单二进制部署**：`cargo build --release` 生成单个可执行文件，无运行时依赖
- **异步性能**：Tokio 处理并发请求，工具执行通过 `block_in_place` 避免阻塞事件循环
- **类型安全**：`Tool` trait + `HashMap<String, Value>` 的组合在保持灵活性的同时保证了编译期检查
- **跨平台编译**：CI 中在 `macos-latest` (ARM) 上交叉编译 `x86_64-apple-darwin`，无需维护多台构建机

### 局限性

- **网页 AI 工具调用不稳定**：不同平台、不同模型对 YAML 工具调用的格式遵循程度参差不齐
- **DOM 结构变化风险**：AI 平台更新 UI 可能导致 CSS 选择器失效，需要持续维护
- **并非 API 替代品**：通过浏览器模拟操作驱动 AI，延迟和可靠性都无法与原生 API 工具调用相比

---

## 10. 相关链接

- **项目地址**：[github.com/dahai9/openlink-rs](https://github.com/dahai9/openlink-rs)
- **原始项目**：[github.com/afumu/openlink](https://github.com/afumu/openlink)（Go 实现）
- **技术栈**：Rust 2024 / Axum 0.8 / Tokio / TypeScript / Vite / Manifest V3
