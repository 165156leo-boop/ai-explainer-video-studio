# AI 科普动画生产工作台｜网页

项目状态和业务边界见 [`../PROJECT.md`](../PROJECT.md)；产品需求见 [`../PRD.md`](../PRD.md)。本文件只记录网页组件的运行、配置和验证方式。

## 本地运行

```powershell
npm.cmd install
npm.cmd run dev
```

打开 [http://localhost:3000](http://localhost:3000)。`127.0.0.1:3000` 是兼容地址，两者读取同一份服务器数据。

首次打开需要用邮箱和至少 8 位密码注册；之后登录即可。项目、规则、素材、媒体任务和模型 Key 都按邮箱隔离，退出后不会继续读取上一位用户的数据。

DOCX 接口调用 `../AI视频agent/scripts/extract_story_sections.py`。需要指定 Python 或提取器时设置：

```powershell
$env:AUDIT_VIDEO_PYTHON = "C:\path\to\python.exe"
$env:AUDIT_VIDEO_EXTRACTOR = "F:\path\to\extract_story_sections.py"
npm.cmd run dev
```

## 数据与配置

- 权威数据：`data/workbench-data.json`；媒体任务数据保存在 `data/` 下对应文件。
- JSON 使用同目录临时文件替换，并保留可恢复备份；浏览器存储只用于旧项目迁移和最近项目记录。
- 文本模型、视觉模型和 Provider 在工作台设置页配置；登录用户的模型 Key 保存在 `data/ai-config-*.json`，不返回浏览器、不进入项目数据或备份。未登录的环境变量配置只作为兼容回退，不会被登录用户直接共享。
- Provider 默认地址为 `http://127.0.0.1:8012`，只接受 loopback 地址。
- 豆包账号也按邮箱归属；升级前已存在的账号会在首次登录时由第一个用户一次性认领。

## 媒体流程

- 页面可提交豆包图片和视频任务、查看候选、调用视觉建议并由用户采用或验收；复制 Prompt、上传和粘贴继续作为故障回退。
- 每次点击只创建当前镜头的一条任务。同一账号最多并发 2 个图片任务，第 3 个排队；视频任务按账号串行；多个账号按负载分流。
- 候选采用、上传和粘贴直接保存原图，不再执行安全区裁切。旧裁切脚本与目录仅用于历史兼容。
- 默认账号的真实单镜头生图、下载和站内回传已验证；第二账号、真实视频和真实候选视觉复核仍待验收。

## 验证

日常排查先跑定向 `check:*`；测试文件、对应命令和故障定位表见根目录 [`DEVELOPMENT.md`](../DEVELOPMENT.md)。

```powershell
npm.cmd run check:all
```

提交前跑完整本地验证（lint、全部回归、TypeScript、生产构建）：

```powershell
npm.cmd run verify
```

也可以单独运行某一组：

```powershell
npm.cmd run lint
npm.cmd run check:shots
npm.cmd run check:projects
npm.cmd run check:memory
npm.cmd run check:extraction
npm.cmd run check:audit
npm.cmd run check:media
npm.cmd run check:speech
npm.cmd run check:storage
npm.cmd run check:auth
npm.cmd run check:upstream-errors
npm.cmd run check:polish-lane
npm.cmd run check:polish-state
npm.cmd run check:stream
npm.cmd run check:async
npx.cmd tsc --noEmit
npm.cmd run build
```

仓库根目录另有：

```powershell
python -B AI视频agent/scripts/test_extract_story_sections.py
powershell -ExecutionPolicy Bypass -File scripts/check-backup.ps1
```

Provider 自身验证在 `../doubao-native-provider/` 中执行 `npm.cmd test` 和 `npm.cmd run smoke:fake`；假任务不消耗媒体额度。

## 部署边界

当前登录是本地邮箱+密码账号，用户和项目仍保存在本机 JSON，DOCX 接口依赖本机 Python 和工作区路径。公开部署前必须改用持久数据库、私有对象存储、邮件验证/找回密码、审计日志和线上 Python 服务；真实校内数据不得进入匿名 Demo。
