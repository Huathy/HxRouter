# Docker

容器化运行 HxRouter。已发布镜像：
- GHCR：[`ghcr.io/huathy/hxrouter`](https://github.com/Huathy/HxRouter/pkgs/container/HxRouter)
- Docker Hub：[`huathy/hxrouter`](https://hub.docker.com/r/huathy/hxrouter)（如单独发布）

多平台支持 `linux/amd64` + `linux/arm64`。

---

# 👤 用户指南

## 快速开始

```bash
docker run -d \
  -p 20128:20128 \
  -v 9router-data:/app/data \
  -v hxrouter-data:/migration-data:ro \
  -v vansrouter-data:/migration-vansdata:ro \
  -e DATA_DIR=/app/data \
  --name hxrouter \
  ghcr.io/huathy/hxrouter:latest
```

`hxrouter-data` 与 `vansrouter-data` 挂载为只读兼容输入，供 v1.0.0 之前使用命名卷的安装使用。仅当 `9router-data` 卷中没有数据库时，才会按顺序将旧卷中缺失的文件复制到该规范卷中。若旧安装使用 `$HOME/.9router:/app/data` 绑定挂载，请继续使用该绑定挂载，或先将其内容迁移到 `9router-data` 中。

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

## 上下文压缩

上下文压缩在 Node 进程内完成，依赖已随应用安装的 `thincontext`。启用 Dashboard → Token Saver → Compress context 后，系统会在请求路由前压缩重复的 system/tool 上下文；压缩失败会记录诊断并保留原始请求继续发送，不需要额外容器、环境变量或 Python 依赖。

## 无需手动资源或数据库步骤的更新

`9router-data` 是规范卷。compose 文件还以只读方式挂载历史 `hxrouter-data` 和 `vansrouter-data`，用于自动兼容复制。入口点仅在 `/app/data/db/data.sqlite` 不存在时按 `hxrouter-data`、`vansrouter-data` 顺序复制完整旧数据树中缺失的文件，并记录 `.legacy-volume-migrated`；从不覆盖已有的规范文件。使用宿主机绑定挂载（`$HOME/.9router:/app/data`）的旧安装必须保留该绑定挂载，或在切换到命名卷前将其内容复制到 `9router-data` 中。

```bash
docker compose pull hxrouter
docker compose up -d --no-deps hxrouter
```

固定版本：在 compose 文件中将 `latest` 替换为 `X.Y.Z` 后再 pull。请勿复制 `.next`、删除任一卷、或手动运行应用迁移。升级成功后，仅当确认新容器报告了预期版本和数据后，再移除 `hxrouter-data:/migration-data:ro` 与 `vansrouter-data:/migration-vansdata:ro` 挂载。

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
- `ghcr.io/huathy/hxrouter:X.Y.Z` + `:latest`

当前工作流不发布 Docker Hub；其列表仅视为单独/手动分发。

```bash
# 遵循 .agent/cicd.md；请勿手动 tag 或发布。
git status --short
node cli/scripts/validate-release.cjs vX.Y.Z --pretag
```

工作流：`.github/workflows/release.yml`
