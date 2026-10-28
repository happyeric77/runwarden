# A 計畫 — 抽取實作計劃（Implementation Plan）

產品定位（2026-10-28 定版）：輕量、自託管的 TypeScript agent runtime 庫，跑在用戶自己的 Postgres 上；門面是 enforced tool-call policy + governance + audit，durability 是地基。灘頭受眾：indie developer / solo founder。形態：純庫四件套（核心 npm 包 + `npx init` schema 遷移 + `runWorker()` 與 compose 模板 + 30 分鐘示例），v1 不做託管 SaaS，MIT/Apache-2.0，GitHub + npm。

來源盤點基於 2026-10-28 對 happyeric77/smb-ops 的實際目錄讀取。

## 抽取地圖（檔案級）

### 直接搬（runtime 通用，無領域邏輯）
- `packages/native-agent-runtime/` 全部 → 新倉 `packages/runtime`
  - `src/contracts.ts`（`AgentRuntime.invoke()` 契約）
  - `src/ai-sdk-native-runtime.ts`（ToolLoopAgent runtime + policy 執行）
  - `src/native-mcp-client.ts`
  - 測試隨行（ai-sdk-native-runtime.test.ts、native-mcp-client.test.ts — PR #279 的迴歸資產）
- `apps/worker/src/` 的 worker 核心 → 包內的 `runWorker()`
  - `assistant-invocations.ts`（claim/lease 生命週期）、`worker-identity.ts`、`shutdown-state.ts`、`readiness.ts`、`startup-validation.ts`（+ 各自測試）
- `packages/db/src/schema/` 的三張表 → 新倉 schema 包
  - `assistant-invocations.ts`、`worker-leases.ts`、`delegated-tool-call-audits.ts`（+ 共用 enums 摘出）

### 改造後搬（去領域化）
- `contracts.ts` 的 invocation 負載：SMB 專屬上下文（tenant、客服語義）→ 通用 `{ prompt, tools, context }`；tenant 隔離鍵 → 通用 `scope` 欄位
- Policy 顯式化：目前散在 `ai-sdk-native-runtime.ts` 的執行邏輯（exactly-one tool call、one-correction-per-incident）收攏成 `defineRuntime({ policies })` 的宣告式設定（allowlist、correctionBudget、requireApproval 名單）——這是產品的門面，必須是一等 API

### 留在 smb-ops（領域邏輯，不搬）
- worker：`telegram*.ts`、`web-push*.ts`、`scheduled-tasks.ts`（投遞與排程）、`agent-runtime.ts`（組裝接線，之後改為消費新包）
- schema：customers、customer-note-revisions、conversations、conversation-messages、message-deliveries、tenants / tenant-*、channel-user-bindings、gateway-device-actions、web-push-subscriptions、workspace-*、scheduled-agent-tasks

## 階段與完成判據

### Phase 0 — 決策凍結（輕量，Sprint 期間可做）
- [ ] 最終命名定版（牧場家族方向已定；Corral 已出局，Drover / Lariat / Paddock 待查核）＋ npm scope、GitHub 倉名
- [ ] License 二選一：MIT / Apache-2.0
- [ ] 建私有倉（先私有抽取、跑通再公開，避免半成品曝光）
- 判據：倉庫存在、名字與 license 寫進 README 草稿

### Phase 1 — 核心包抽取
- [ ] 搬 `native-agent-runtime` → `packages/runtime`，測試全綠
- [ ] `contracts.ts` 去領域化（通用 invocation 負載 + scope 欄位）
- [ ] Policy 宣告式化：`defineRuntime({ db, provider, mcpServers, policies })`
- 判據：一個不含任何 SMB 字眼的 demo 腳本能用新包跑完一輪 governed invocation

### Phase 2 — Worker 與 Schema
- [ ] 三張表抽成 schema 包 + 遷移；`npx <name> init` 在空 Postgres 上建表成功
- [ ] worker 核心抽成 `runWorker()`；docker-compose 模板（app + worker + postgres）
- 判據：全新環境照 README 三步內把 worker 跑起來

### Phase 3 — 示例與文件（公開前的門面）
- [ ] 30 分鐘示例：一個小 MCP server + 一輪帶 policy 與 audit 的 invocation，含「故意選錯工具被攔下」的演示段
- [ ] README：定位句、「not for」清單（超大吞吐、跨地域、多語言、長編排不做）、與 DBOS 的一句話區別
- [ ] （可後置）smb-ops 改為消費公開包，dogfood 閉環
- 判據：沒看過專案的人照 README 在 30 分鐘內跑通示例

### Phase 4 — B 的 Harness（第二里程碑，不與 Phase 1 並行）
- [ ] 把 #264/#272/#275 的 acceptance 方法抽成通用測試工具：凍結場景 schema、串行重複 runner、proposal 捕獲、混淆矩陣報告
- [ ] 對任意 MCP server（stdio / HTTP）可跑；CLI + GitHub Action
- 判據：拿 smb-ops 自己的 MCP server 當靶子，完整跑出一次路由可靠性報告

## 時間與節奏

- 原定動手時間為 Storm King sprint 結束（2026-11-18）後；Phase 0 為輕量決策步，可在 Sprint 期間穿插；Phase 1 起為編碼密集段，建議 Sprint 後整段投入。
- 紀律：C 凍結期間不往 smb-ops 商家功能寫程式碼；smb-ops 本體不遷 DBOS。
