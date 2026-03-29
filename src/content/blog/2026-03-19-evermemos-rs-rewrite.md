---
title: '为什么用 Rust 重写了 Agent 长效记忆系统？'
description: '本文分享了我们将 EverMemOS 从 Python 重写为 Rust 的历程，以及如何通过“记忆基础设施化”为多语言生态提供原生支持。'
pubDate: 'Mar 19 2026'
heroImage: '../../assets/evermemos-rs-rewrite-banner.png'
---

> **摘要**：在 AI Agent 遍地开花的今天，记忆系统（Memory）往往被视为一段 Python 脚本。但当我们要支撑高并发、低延迟的生产级 Agent 时，Python 的性能瓶颈开始显现。本文分享了我们将 EverMemOS 从 Python 重写为 Rust 的历程，以及如何通过“记忆基础设施化”为多语言生态提供原生支持。

---

## 1. 现状：被困在 Python 里的“记忆”

目前市面上绝大多数 Agent 框架（如 LangChain, CrewAI） and 记忆组件都是纯 Python 实现的。Python 在原型开发和 AI 实验阶段非常优秀，但当我们将视角转到**生产级基础设施**时，问题接踵而至：

- **并发瓶颈**：Python 的 GIL 限制了多线程处理大规模检索排序（Reranking）的能力。
- **冷启动与内存占用**：Python 运行时的臃肿对于边缘计算或轻量化部署并不友好。
- **记忆即脚本 vs 记忆即服务**：记忆不应该只是一个 `json` 文件或简单的 `chromadb` 封装，它应该像 Redis 或 PostgreSQL 一样，作为一种高性能、高可靠的**基础设施（Infra）**存在。

## 2. 变革：Rust 重写背后的“硬核”逻辑

我们决定使用 **Rust** 对 EverMemOS 进行底层重写（即 `evermemos-rs`），主要基于以下三个维度的考量：

### 🚀 极致性能
通过 Rust 的异步运行时（Tokio）和零成本抽象，我们将记忆提取（Extraction）和检索（Retrieval）的端到端延迟降低了约 **60%**。在处理复杂的 Hybrid Search（向量+全文+RRF）时，Rust 的表现堪称惊艳。

### 🛠️ 记忆即基础设施（Memory as Infra）
我们将记忆系统重新定义为底层的 Infra：
- **底层存储**：切换到了 **SurrealDB**，利用其原生支持的图查询和向量索引。
- **通信协议**：除了 REST API，我们原生支持了 **MCP (Model Context Protocol)**，让 Agent 能够像调用系统指令一样调用记忆。

### 🧩 真正的多语言生态
记忆不应该只服务于 Python 开发者的 `pip install`。重写后，我们通过 Rust 的 FFI 和高效的 REST/gRPC 接口，正式推出了三大主流语言的 SDK。

---

## 3. 开发者体验：三路并进的 SDK

无论你是在写 Python AI 应用，还是在构建 Next.js 的 AI 交互界面，甚至是开发高性能的 Rust Agent，EverMemOS 都能无缝接入。

### 🐍 Python SDK
针对数据科学家 and 主流 Agent 框架开发者的习惯，保持了极简的 API 设计。

```python
from evermemos import MemoryClient

client = MemoryClient(api_key="your_key")
# 自动提取 MemCell 并存储
client.memorize(
    user_id="user_123", 
    content="我明天下午三点在上海有个关于 Rust 性能优化的会议。"
)
```

### 📦 TypeScript SDK
为 Web 端和 Node.js 环境提供全类型的异步支持。

```typescript
import { EverMemos } from '@evermemos/sdk-js';

const memos = new EverMemos({ endpoint: 'http://localhost:8080' });
const context = await memos.retrieve({
  userId: 'user_123',
  query: '明天的行程安排？',
  strategy: 'agentic' // 启用智能检索策略
});
```

### 🦀 Rust SDK
对于追求极致性能的底层开发者，提供原生的 `async/await` 支持和类型安全。

```rust
use evermemos_rs_sdk::{Client, RetrievalStrategy};

#[tokio::main]
async fn main() {
    let client = Client::new("http://localhost:8080");
    let results = client.search("user_123")
        .query("Rust 性能")
        .strategy(RetrievalStrategy::Hybrid)
        .limit(5)
        .await?;
}
```

---

## 4. 性能数据对比

TODO
