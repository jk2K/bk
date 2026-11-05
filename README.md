# BK

Git 原生业务知识自动演进 CLI。监听 Git 与网页来源，提出可追溯的业务规则变更，由人工审核后进入正式知识库。

**当前为 0.1 开发预览版**。已打通 Git → Claude Agent SDK → 证据校验 → 隔离 worktree → 本地提案 / Draft PR 的核心链路。完整需求与设计分别见 [PRD](docs/01-PRD.md) 和 [技术设计](docs/02-TECHNICAL-DESIGN.md)；功能边界与验证情况见 [实现状态](docs/IMPLEMENTATION.md)。

## 开发与安装

要求 Node.js 24+、Git；远程审核需要已认证的 `gh`、`glab` 或 Gitea `gt` / `tea`。

```bash
npm ci
npm run build
npm test
npm link
bk --help
```

网页来源另外安装浏览器：

```bash
npx playwright install chromium
```

## 初始化知识仓库

CLI 源码仓库与业务知识仓库分开维护。

```bash
bk init ../business-knowledge
cd ../business-knowledge
git init -b main
git add .
git commit -m "Initialize business knowledge"
```

`bk init` 不覆盖既有文件，并将 `.bk/` 加入 `.gitignore`。所有扫描快照、SQLite、浏览器 Profile 和候选 worktree 均存放在 `.bk/`。

编辑 `bk.yaml`，加入你的来源，例如：

```yaml
sources:
  - id: product-prd
    type: git
    role: requirement
    url: /absolute/path/to/prd-repository
    branch: main
    include: ["**/*.md"]
    exclude: ["**/drafts/**"]
    interval: 30m
    data_classification: public
```

支持 `requirement`、`design`、`implementation`、`test`、`external-policy` 五种证据角色。源码或测试独立提出的规则写入会被降级为冲突报告，不能直接替代批准的业务意图。修改来源 URL、分支或范围时请使用新来源 ID；当前不提供自动检查点迁移。

## 执行

```bash
# 扫描无需模型权限，不调用 Agent
bk scan
bk status --json

# 配置企业批准的模型认证；可使用 SDK 支持的云平台环境认证
export ANTHROPIC_API_KEY=your-approved-key
bk doctor

# 先预览，再生成隔离的本地待审提案
bk sync --dry-run
bk sync --local
bk proposals

# 内置常驻调度，Ctrl+C / SIGTERM 优雅停止
bk watch
```

`--json`、`-C <知识仓库路径>` 为全局选项，可放在命令前后。失败返回非零退出码。`doctor` 检查环境认证变量是否存在，**不代表模型已实际验证可用**。

默认来源分类是 `internal`，默认禁止向模型传输内部数据。确认已获准传输后，在 `agent` 中明确配置 `allow_internal_data: true`；`restricted` 来源始终阻断。凭据仅放在环境或平台 CLI 凭据系统，不写入 YAML。内置脱敏只是辅助，不能代替公司的数据准入判断。

模型失败后，事件会保存并退避重试；达到上限或被策略阻断后，修复原因再手动重排：

```bash
bk history --limit 20
bk retry <change-id>
bk analyze
```

`sync --dry-run` 允许本地扫描、缓存和模型调用，但不创建提案分支、不提交、不 Push、不创建远程 PR，也不会消费掉待分析事件。

## 网页与登录态

```yaml
sources:
  - id: internal-wiki
    type: web
    role: requirement
    url: https://wiki.example.com/business/
    interval: 6h
    browser:
      profile: internal-wiki
      headless: true
      login_url: https://wiki.example.com/login
      auth_selector: "[data-authenticated-user]"
    crawl:
      allowed_hosts: ["wiki.example.com"]
      include: ["/business/**"]
      exclude: ["/business/admin/**"]
      max_depth: 2
      max_pages: 30
      wait_for: main
```

```bash
bk browser login internal-wiki
# 手动完成 SSO/MFA 后关闭浏览器窗口
bk browser status internal-wiki
bk source test internal-wiki
```

不同 Profile 独占使用；自动抓取限制主机、导航路径与请求方法，拦截写请求，保留可见正文、链接和 Markdown 表格。需要资源 CDN 时显式加入 `allowed_hosts`。建议配置 `auth_selector`，否则无法可靠区分所有自定义 SSO 登录页。登录失效的来源在 watch 中暂停；成功登录后重新启用。

当前网页路径支持普通 DOM 采集与站内链接遍历。Agent 智能点击/分页、图片视觉理解与浏览步骤自动沉淀尚未实现；开启相关配置会明确报错。

## 人工审核

默认 `review.mode: local`：提案、报告和补丁位于 `.bk/proposals/<id>/`，正式工作树不变。审核后可检查并合并本地 `bk/knowledge/<id>` 分支。规则正文采用 `bk:statement` 标记，后续更新只替换受管理正文并更新元数据，保留标记外的人工段落。

远程审核示例：

```yaml
review:
  mode: pull-request
  provider: github # github | gitlab | gitea；显式指定自建平台
  cli: gh          # gh | glab | gt | tea
  auto_merge: false
  proposal_branch_prefix: bk/knowledge/
```

为知识仓库配置 `origin` 并完成平台 CLI 登录。BK 创建独立分支和待审核 PR/MR，按分支查询以避免远程成功、本地失败后重复创建。不会自动合并。重跑会查询审核状态，只有确认合并提交包含在目标分支时才记录发布。读取远程最新正式规则不会检出或覆盖用户工作树。

目前按来源变更事件隔离提案；多个事件连续更新同一规则时可能产生需要人工处理的分支冲突，还没有实现跨事件的同规则 PR 合并更新。

## 校验与测试

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
bk validate
```

测试使用本地真实 Git 仓库验证新增、修改、重命名、删除、强推、持久检查点、模型失败重试、干运行、提案去重及用户工作区隔离。平台 CLI 使用契约模拟测试；不将其等同于真实平台联调。Claude SDK 权限配置禁用任意内置工具与项目设置，仅处理提供的证据。
