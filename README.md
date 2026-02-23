# Vibe Board（多设备任务看板）

## 项目背景
在多设备、多 Agent 协作开发场景里，任务状态通常分散在各自终端或本地工具中，团队很难快速回答这些问题：

- 哪台机器正在处理哪些任务？
- 哪些任务已经完成并等待验收？
- 某个 Agent 是否离线，离线了多久？

`vibe-board` 的目标是把这些分散状态聚合到统一看板中，并提供可落地的开发/产线运行方式。

## 功能概览
### 核心能力
- 多机器任务聚合看板（按机器/Agent 维度展示）
- 任务状态统计：`进行中`、`待验收`、`已验证`
- 任务明细查看与状态筛选
- 任务标题中的 `<image></image>` 标记清理
- 任务预览图缩略图展示，支持点击放大预览
- 机器显示名称支持 UI 配置（优先于 Agent 上报名称）
- Agent 在线/离线识别，离线卡片自动排后

### 提醒能力
- 当某卡片出现任务从 `进行中` 进入 `待验收` 时：
  - 播放声音提醒
  - 卡片闪动提醒（持续 1 分钟）

### Agent 能力
- 支持通过 `agent.config.json` 做简易配置
  - 远程上报地址
  - 机器名称/机器标识
  - 各适配器参数
- 支持 `Windows / macOS / Linux` 跨平台打包
- 提供 GitHub Actions 进行 Agent 打包与发布

## 架构说明
统一通过 `gateway` 暴露入口端口 `61100`：

- `gateway`（Nginx）
  - `/api/*` 转发到 `api`
  - `/` 转发到 `ui`
- `api`（Node.js + Express）
  - 接收 Agent 上报
  - 聚合并提供看板 API
- `ui`（Nginx 静态站点）
  - 提供看板前端
- `mysql`
  - 持久化任务与机器数据
- `agent`
  - 本地采集任务并上报到 `api`

## 环境要求
- Docker + Docker Compose v2
- Node.js + npm（用于本地 Agent 开发/打包）

## 目录结构（关键文件）
- `docker-compose.yml`：默认产线编排（`api/ui` 走镜像构建）
- `docker-compose.dev.yml`：开发覆盖（`api/ui` 走源码挂载热更新）
- `start-dev.sh`：开发模式一键启动（docker dev + 本地 agent dev）
- `start-prod.sh`：产线模式一键启动（docker build + agent release build）
- `reset-mysql.sh`：重置 MySQL 数据库
- `cleanup-offline-cards.sh`：清理灰色（离线）卡片的数据
- `agent/agent.config.example.json`：Agent 配置模板（含参数说明）

## 使用说明
### 1) 开发模式（推荐日常开发）
开发模式特点：

- `server api/ui` 使用挂载模式，改代码无需重新 build docker
- `agent` 本地 `npm run dev` 热更新

启动：

```bash
./start-dev.sh
```

启动后：

- 看板地址：`http://localhost:61100/`
- API 地址：`http://localhost:61100/api/*`
- 服务日志：`.dev-server.log`
- Agent 日志：`.dev-agent.log`

说明：

- 若 `agent/agent.config.json` 不存在，脚本会自动由 `agent/agent.config.example.json` 生成。
- 默认按 Ctrl+C 退出时会自动停止 docker 服务。
- 如需退出脚本但保留 docker 服务：

```bash
KEEP_DOCKER_ON_EXIT=1 ./start-dev.sh
```

手动停止开发栈：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

### 2) 产线模式（构建镜像运行）
产线模式特点：

- `api/ui` 代码打包进 Docker 镜像后运行
- 可选执行 Agent release build

启动：

```bash
./start-prod.sh
```

启动后：

- 看板地址：`http://localhost:61100/`
- API 地址：`http://localhost:61100/api/*`
- 服务快照日志：`.prod-server.log`
- Agent 打包输出：`agent/release/`

默认会执行 Agent release build（`npm run package:agent`）。
如需跳过：

```bash
BUILD_AGENT_RELEASE=0 ./start-prod.sh
```

停止产线栈：

```bash
docker compose -f docker-compose.yml down
```

## 数据库重置
> 警告：该操作会清空数据库业务数据。

执行：

```bash
./reset-mysql.sh
```

行为：

- 等待 MySQL 就绪
- `DROP DATABASE` + `CREATE DATABASE`
- 重启 `api` 服务触发表结构重建

可通过环境变量覆盖数据库名/密码：

```bash
MYSQL_DATABASE=vibe_board MYSQL_ROOT_PASSWORD=vibe_root ./reset-mysql.sh
```

## 清理灰色（离线）卡片数据
> 警告：该操作会删除离线卡片及关联任务/历史记录。

执行：

```bash
./cleanup-offline-cards.sh
```

常用参数：

```bash
# 仅预览将删除哪些数据
./cleanup-offline-cards.sh --dry-run

# 自定义离线判定阈值（秒）
./cleanup-offline-cards.sh --offline-seconds 300
```

## Agent 配置说明
推荐基于模板：

```bash
cp agent/agent.config.example.json agent/agent.config.json
```

常用字段：

- `report_endpoint`：上报地址（默认 `http://127.0.0.1:61100/api/report`）
- `machine_id`：机器唯一标识
- `machine_name`：看板展示机器名称
- `report_interval_seconds`：上报周期秒数
- `env`：适配器相关参数（如 Codex/Claude/OpenCode 路径与窗口期）

配置优先级：

`环境变量 > 配置文件 > 内置默认值`

## 常用命令速查
```bash
# 开发模式（docker dev + agent dev）
./start-dev.sh

# 产线模式（docker build + 可选 agent release）
./start-prod.sh

# 重置数据库
./reset-mysql.sh

# 清理灰色（离线）卡片数据
./cleanup-offline-cards.sh

# 仅手动启动开发 docker 栈
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# 仅手动停止开发 docker 栈
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

## API 简要
### 上报接口
- `POST /api/report`

示例请求体：

```json
{
  "machine_id": "pc1",
  "machine_name": "PC-Dev-1",
  "machine_fingerprint": "stable-machine-fp-001",
  "tasks": [
    { "id": "t3", "title": "Run tests", "status": "in_progress" },
    { "id": "t2", "title": "Write API docs", "status": "completed_pending_verification" }
  ]
}
```

### 其他接口
- `GET /api/dashboard/history?machine_id=<id>&task_id=<task>&limit=<n>`
- `PUT /api/dashboard/machine/:id/display-name`

## 备注
- 任务按 `(machine_id, task.id)` 进行持久化去重。
- 机器按 `machine_fingerprint + agent_name` 聚合：
  - 同机器不同 Agent：分多张卡片
  - 同 Agent 变更 `machine_id`：仍归并到同卡片
- 默认离线判定：超过 `AGENT_OFFLINE_TIMEOUT_SECONDS`（默认 `45s`）未上报。
