# Docker

容器化运行 HxRouter。已发布镜像：
- GHCR：[`ghcr.io/vanszs/hxrouter`](https://github.com/Huathy/HxRouter/pkgs/container/HxRouter)
- Docker Hub：[`vanszs/hxrouter`](https://hub.docker.com/r/vanszs/hxrouter)（如单独发布）

多平台支持 `linux/amd64` + `linux/arm64`。

---

# 👤 用户指南

## 快速开始

```bash
docker run -d \
  -p 20128:20128 \
  -v 9router-data:/app/data \
  -v hxrouter-data:/migration-data:ro \
  -e DATA_DIR=/app/data \
  --name hxrouter \
  ghcr.io/vanszs/hxrouter:latest
```

`hxrouter-data` 挂载为只读兼容输入，供 v1.0.0 之前使用命名卷的安装使用。仅当 `9router-data` 卷中没有数据库时，才会自动复制到该规范卷中。若旧安装使用 `$HOME/.9router:/app/data` 绑定挂载，请继续使用该绑定挂载，或先将其内容迁移到 `9router-data` 中。

应用监听端口 `20128`。访问：http://localhost:20128

## 管理容器

```bash
docker logs -f hxrouter        # 查看日志
docker stop hxrouter           # 停止
docker start hxrouter          # 再次启动
docker rm -f hxrouter          # 删除
```

## 数据持久化

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

未设置 `DATA_DIR` 时，应用回退到 `~/.9router/`（macOS/Linux）或 `%APPDATA%\9router\`（Windows）。容器中设置 `DATA_DIR=/app/data` 以使绑定挂载生效。

`$DATA_DIR/` 下的数据布局：

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # 主 SQLite 数据库
│   └── backups/          # 自动备份
└── ...                   # 证书、日志、运行时配置
```

宿主机路径：`$HOME/.9router/db/data.sqlite`
容器路径：`/app/data/db/data.sqlite`

生产环境要求：
- 每个 SQLite 文件只运行一个 HxRouter 进程。多个容器/进程使用独立本地卷不共享代理池健康状态。
- 如需横向扩展，请先提供共享数据库/后端用于路由状态，再启用多应用实例。
- 保留 `docker-compose.yml` 使用的持久卷名 `9router-data`；重命名会创建新的空数据库卷。
- 生产环境需要原生 SQLite 驱动。`sql.js` 仅作为单进程开发的回退方案。

## 可选环境变量

在快速启动命令中添加选项：

```bash
-e PORT=20128 \
-e HOSTNAME=0.0.0.0 \
-e DEBUG=true
```

## 可选 Headroom 边车

Headroom 是可选的边车服务，用于工具历史安全与高级请求处理。

### 方案 A：Docker Compose（推荐）

使用提供的 `docker-compose.yml`：

```bash
# 复制并自定义环境
cp .env.example .env
nano .env

# 启动两个服务
docker compose up -d
```

### 方案 B：手动 Compose

自行创建 `docker-compose.yml`：

```yaml
services:
  hxrouter:
    image: ghcr.io/vanszs/hxrouter:latest
    container_name: hxrouter
    restart: always
    ports:
      - "20128:20128"
    volumes:
      - 9router-data:/app/data
    env_file:
      - .env
    environment:
      DATA_DIR: /app/data
      PORT: "20128"
      HOSTNAME: "0.0.0.0"
      NODE_ENV: production
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    container_name: headroom
    restart: always
    ports:
      - "8787:8787"

volumes:
  9router-data:
    name: 9router-data
```

### 方案 C：独立容器

独立运行 Headroom：

在仪表盘中打开 `Endpoint` → `Token Saver` → `Headroom`，确认 URL 为 `http://headroom:8787`，重新检查状态，然后启用 Headroom。

若 Headroom 运行在 Docker 宿主机而非边车，macOS/Windows 上使用 `http://host.docker.internal:8787`。Linux 上添加 `--add-host=host.docker.internal:host-gateway` 或等效的 compose `extra_hosts` 配置。

## 无需手动资源或数据库步骤的更新

`9router-data` 是规范卷。compose 文件还以只读方式挂载历史 `hxrouter-data`，用于自动兼容复制。入口点仅在 `/app/data/db/data.sqlite` 不存在时复制完整旧数据树，并记录 `.legacy-volume-migrated`；从不覆盖已有的规范文件。使用宿主机绑定挂载（`$HOME/.9router:/app/data`）的旧安装必须保留该绑定挂载，或在切换到命名卷前将其内容复制到 `9router-data` 中。

```bash
docker compose pull hxrouter
docker compose up -d --no-deps hxrouter
```

固定版本：在 compose 文件中将 `latest` 替换为 `X.Y.Z` 后再 pull。请勿复制 `.next`、删除任一卷、或手动运行应用迁移。升级成功后，仅当确认新容器报告了预期版本和数据后，再移除 `hxrouter-data:/migration-data:ro` 挂载。

---

# 🛠 开发者指南

## 本地构建镜像（测试）

```bash
docker build -t hxrouter .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  hxrouter
```

## 发布（通过 CI 自动完成）

按 `.agent/cicd.md` 中的检查后推送带注解的发布标签 `vX.Y.Z`。GitHub Actions 构建多平台（amd64+arm64）并将验证过的镜像提升到：
- `ghcr.io/vanszs/hxrouter:X.Y.Z` + `:latest`

当前工作流不发布 Docker Hub；其列表仅视为单独/手动分发。

```bash
# 遵循 .agent/cicd.md；请勿手动 tag 或发布。
git status --short
node cli/scripts/validate-release.cjs vX.Y.Z --pretag
```

工作流：`.github/workflows/release.yml`
