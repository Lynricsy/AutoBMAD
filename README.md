# 🦊 AutoBMAD

**BMAD-METHOD Phase 4 自动化引擎**

全自动化 Sprint 编排：从规划到开发、对抗性代码审查、修复循环，无人值守完成所有 Story。

> 把重复的 Sprint 流程交给机器，你只需要喝杯咖啡 ☕

## ✨ 功能特性

- 🚀 **全自动 Sprint 编排** — 从 `sprint-planning` 到 `code-review`，一键走完整个流程
- 🔄 **智能修复循环** — `dev` ↔ `review` 自动重试，最多 3 次，直到审查通过
- 💾 **断点续跑** — 中断后从失败点恢复，不浪费已完成的工作
- 🎨 **美观终端仪表盘** — Unicode 方框绘制 + ANSI 彩色输出，清晰掌握进度
- ⚡ **基于 Bun** — 极速启动，TypeScript 原生支持，零编译等待
- 🔧 **可配置** — CLI 参数 / `.autobmad.yaml` / 自定义 Prompt，灵活适配你的项目
- 🧪 **完善测试** — 200 个测试用例，100% 通过

## 📦 安装

### 全局安装（推荐）

```bash
bun add -g auto-bmad
```

安装后即可在任何目录使用 `autobmad` 命令。

### 从源码安装

```bash
git clone https://github.com/Lynricsy/AutoBMAD.git
cd AutoBMAD
bun install
bun run build
bun link
```

## 🚀 快速开始

```bash
# 开始新 Sprint（自动执行规划 → 创建 Story → 开发 → 审查）
autobmad start --dir /path/to/your/bmad-project

# 查看当前 Sprint 状态
autobmad status --dir /path/to/project

# 中断后恢复执行
autobmad resume --dir /path/to/project

# 重置本地运行状态
autobmad reset --dir /path/to/project
```

如果从源码安装，也可以直接运行：

```bash
bun run src/cli/index.ts start --dir /path/to/project
```

## ⚙️ 配置

在项目根目录创建 `.autobmad.yaml` 文件即可自定义配置：

```yaml
# 每个 Story 的最大重试次数（dev↔review 循环）
maxRetries: 3

# 单次工作流超时（秒）
timeout: 300

# 开启详细日志
verbose: false

# 自定义各阶段 Prompt（可选）
prompts:
  sprint-planning: "你的自定义 Sprint 规划 Prompt..."
  create-story: "你的自定义 Story 创建 Prompt..."
  dev-story: "你的自定义开发 Prompt..."
  code-review: "你的自定义审查 Prompt..."
```

CLI 参数会覆盖配置文件中的同名选项：

| 参数 | 缩写 | 说明 |
|------|------|------|
| `--dir` | `-d` | 项目目录路径（默认：当前目录） |
| `--verbose` | `-v` | 开启详细日志输出 |
| `--help` | `-h` | 显示帮助信息 |

## 🏗️ 架构

```
AutoBMAD/src
├── cli/                          # CLI 层
│   ├── index.ts                  # 入口 + 参数解析
│   ├── dashboard.ts              # 终端仪表盘（美化输出）
│   └── commands/
│       ├── start.ts              # 启动 Sprint
│       ├── resume.ts             # 断点恢复
│       ├── status.ts             # 状态查看
│       └── reset.ts              # 状态重置
│
└── core/                         # 核心引擎
    ├── sprint-orchestrator.ts    # Sprint 编排器（主循环）
    ├── story-processor.ts        # Story 处理器（dev↔review 循环）
    ├── runner.ts                 # 工作流运行器（调用 oh-my-opencode）
    ├── router.ts                 # 工作流路由（映射 workflow → agent）
    ├── state-manager.ts          # Sprint 状态管理（YAML 读写）
    ├── run-state.ts              # 运行状态持久化（JSON，断点续跑）
    ├── config.ts                 # 配置加载与合并
    ├── prompts.ts                # Prompt 模板管理
    ├── logger.ts                 # 日志系统
    ├── errors.ts                 # 错误类型定义
    └── types.ts                  # TypeScript 类型与接口
```

**核心流程：**

```
Sprint Orchestrator
  │
  ├─ 1. sprint-planning  → 生成 Sprint 规划
  ├─ 2. create-story     → 为每个 Story 创建详细描述
  └─ 3. 遍历所有 Story:
       ├─ dev-story       → 执行 TDD 开发
       ├─ code-review     → 对抗性代码审查
       └─ 失败? → 重试（最多 maxRetries 次）
```

## 🧪 测试

```bash
# 运行全部测试
bun test

# 类型检查
bun run typecheck
```

项目包含 200 个测试用例，覆盖核心模块的所有关键路径。

## 📋 前提条件

- [Bun](https://bun.sh) 运行时（v1.0+）
- [oh-my-opencode](https://github.com/anthropics/opencode) 及 oh-my-opencode 插件已安装并配置
- 一个遵循 BMAD-METHOD 的项目，包含 `sprint-status.yaml` 文件

## 🛠️ 技术栈

| 组件 | 选型 |
|------|------|
| 运行时 | Bun |
| 语言 | TypeScript（strict 模式） |
| 运行时依赖 | `yaml` ^2.7.0（仅此一个） |
| 测试 | `bun test` |
| 状态存储 | YAML + JSON 文件系统 |

## 📤 发布

本项目通过 GitHub Actions 自动发布到 npm。

### 发布新版本

```bash
# 更新版本号（patch/minor/major）
npm version patch

# 推送 tag 触发自动发布
git push --follow-tags
```

发布需要在 GitHub 仓库设置中配置 `NPM_TOKEN` Secret。

## 📄 License

[MIT](LICENSE)
