# 开发与回归手册

本文件只回答两件事：改某类功能应该先看哪里，以及改完应该跑什么。产品目标和当前事实不在这里重复，分别看 [`PRD.md`](PRD.md) 与 [`PROJECT.md`](PROJECT.md)。

## 文档分工

| 要回答的问题 | 唯一入口 |
|---|---|
| 当前做到什么、已决定什么、下一步是什么 | [`PROJECT.md`](PROJECT.md) |
| 做什么、不做什么、验收标准 | [`PRD.md`](PRD.md) |
| 画面、人物、连续性和 Prompt 视觉规则 | [`STYLE_GUIDE.md`](STYLE_GUIDE.md) |
| 本地启动、配置和测试命令 | [`README.md`](README.md) 与本目录的 [`publicity-video-ai-workbench/README.md`](publicity-video-ai-workbench/README.md) |
| 修改定位、回归矩阵和故障排查 | 本文件 |

`AI视频agent/项目/` 是生产素材和历史快照，不是当前代码或产品规则的权威来源。

## 改动定位表

| 现象或需求 | 先读/先改 | 第一条回归 |
|---|---|---|
| 登录、邮箱隔离、项目读写 | `publicity-video-ai-workbench/src/app/auth.ts`、`project-store.ts`、`workspace-memory.ts`、`src/app/api/auth/`、`src/app/api/projects/` | `npm run check:projects`、`npm run check:memory` |
| Word 导入、段落分类、案例提取 | `src/app/api/parse-docx/`、`src/app/extraction-review.ts`、`AI视频agent/scripts/extract_story_sections.py` | `npm run check:extraction` |
| 脚本审核、分镜拆分、时长 | `src/app/script-audit.ts`、`shot-planning.ts`、`src/app/api/ai/script-audit/` | `npm run check:audit`、`npm run check:shots` |
| 修改上游后如何继承/作废下游成果 | `src/app/storyboard-workflow.ts`、`media-workflow.ts`、`video-prompt-input.ts`、`polish-digest.ts` | `npm run check:workflow`、`npm run check:async` |
| 画面 Prompt、参考图、人物绑定、尾帧高清化 | `src/app/image-prompt.ts`、`image-prompt-request.ts`、`media-workflow.ts`、`src/app/api/ai/image-prompts/` | `npm run check:shots`、`npm run check:media` |
| 视频 Prompt、镜头1/2/3、台词校验、首帧/尾帧说明 | `src/app/video-prompt.ts`、`src/app/api/ai/video-prompts/route.ts`、`page.tsx` 的视频词区域 | `npm run check:speech` |
| 任务状态、候选、验收、重复提交保护 | `src/app/media-workflow.ts`、`media-provider.ts`、`page.tsx` 的媒体提交区域 | `npm run check:media`、`npm run check:async` |
| 提示词润色的排队、重试、失败分类 | `src/app/polish-lane.ts`、`polish-state.ts`、`ai-output-rejection.ts`、`ai-upstream-error.ts`、`page.tsx` 两处 `queue*PromptPolish` | `npm run check:polish-lane`、`npm run check:polish-state`、`npm run check:upstream-errors`、`npm run check:speech` |
| 候选媒体文件读取与请求取消 | `src/app/media-provider.ts` 的文件流部分 | `npm run check:stream` |
| JSON 原子写入、备份、恢复 | `src/app/json-storage.ts`、`scripts/backup-workbench.ps1`、`scripts/check-backup.ps1` | `npm run check:storage`、`powershell -ExecutionPolicy Bypass -File scripts/check-backup.ps1` |
| 豆包网页控件、账号、额度、语义守卫、提交故障恢复分流 | `doubao-native-provider/src/provider-core.cjs`、`doubao-adapter.cjs`、`semantic-guard.cjs` | `cd doubao-native-provider; npm test` |

页面大文件 `page.tsx` 只负责编排；能放进已有领域模块的逻辑不要继续堆在页面里。

## 回归命令

进入工作台目录：

```powershell
cd publicity-video-ai-workbench
```

最小、无网络、无媒体额度消耗的全套逻辑回归：

```powershell
npm.cmd run check:all
```

代码提交前的完整本地验证：

```powershell
npm.cmd run verify
```

`verify` 依次执行 lint、16 套工作台回归、TypeScript 检查和生产构建。单个问题优先跑上表中的定向命令，确认后再跑 `check:all`，避免每次排查都重复消耗上下文。

> 临时排查脚本不要留在仓库根目录：`eslint` 会扫描它，一条 `any` 就能把 `lint` / `verify` 重新弄红。用完即删。

Provider 单独验证：

```powershell
cd ..\doubao-native-provider
npm.cmd test
npm.cmd run smoke:fake
```

根目录备份安全检查：

```powershell
cd ..
powershell -ExecutionPolicy Bypass -File scripts/check-backup.ps1
```

这些默认回归不会登录豆包、调用文本/视觉模型、生成图片或生成视频。真实端到端验证必须单独说明，会消耗账号额度，并把结果写回 [`PROJECT.md`](PROJECT.md) 或对应的试用/评测记录。

## 故障排查顺序

1. 先复制页面显示的错误码、镜头 ID、账号、时间和任务 ID；没有任务 ID 就先判断请求是否真正提交。
2. 先跑对应的定向回归，排除纯函数、数据校验和状态机问题。
3. 如果定向回归通过，再检查服务端日志和实际请求体；不要只凭页面按钮状态判断成功。
4. 涉及豆包网页的错误，区分“未进入正确模式”“附件未挂上”“提交未被接受”“生成中断”“已生成但未回收”五类，不要直接重试不确定任务。
5. 修改后补一条能复现根因的回归；如果只是模型输出波动，优先在确定性归一化/兜底层修复，不把瞬时失败写成无限重试。

## 修改记录规则

- 稳定决策、当前状态、阻塞和下一步写入 `PROJECT.md`，不要把完整聊天记录贴进去。
- 产品行为或验收变化写入 `PRD.md`；视觉和 Prompt 口径变化写入 `STYLE_GUIDE.md`。
- 每个新故障至少留下：现象、证据、根因、修复位置、回归命令、是否需要真实额度复验。
- 不在文档或测试输出中记录 API Key、Cookie、浏览器 profile 路径或认证头。
- 不把“单元测试通过”写成“豆包端到端通过”；两者必须分开记录。
