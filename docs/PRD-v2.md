# PRD v2.0 — Signal Box

**Voice-compiled policy for an AI commerce workforce**

> Run your AI workforce by voice. Stay on the loop, not in it.

- 版本：v2.0（2026-09-04）
- 取代：PRD v1.0 / SDD v1.0
- 截止：2026-09-30 23:00 TST（剩 26 天）

---

## 0. 這一版改了什麼，以及為什麼

v1.0 是在只看過 skill 摘要、沒讀過賽制、也沒看過競品的情況下寫的。以下每一項都是根據**查證過的事實**改的，不是換句話說。

| # | v1.0 的假設 | 查到的事實 | v2.0 的決定 |
|---|---|---|---|
| 1 | 交件核心是 governance 引擎，dashboard 是 P1，「不要先做漂亮 Dashboard」 | 必交清單明列 **Demo application platform + Application URL** | **Dashboard 升為 P0**。它是門檻，不是加分 |
| 2 | 用 LINE / Telegram 語音訊息，不做即時對話 | Challenge 原文：*"Build a voice agent using AssemblyAI's **real-time** voice AI technology"*，兩條路徑都是即時。評審含 AssemblyAI **Head of Realtime** | **主線改為 Voice Agent API 即時連線**。LINE / TG 語音訊息降為 P1 第二入口 |
| 3 | 建在 OpenClaw 110 支既有 skill 上 | 規則：*"Submissions must be original and MIT-compliant"* + 必交 **Public GitHub repository**。而 v7 README 寫「課程專用，請勿外傳」 | 110 支**不進 repo**。改為：registry 收錄衍生 metadata 當證據；demo 跑一包**新寫的 12–20 支英文 skill** |
| 4 | 賣點是「為 action 加一道閘門」 | 已發布作品第一件 **Voice Action Gate** 就是這個定位，而且做得很紮實 | **改變定位**：不講閘門，講 **policy 的生命週期**與 **on the loop** |
| 5 | 用 Voice Agent API 的 JSON-Schema tool calling 當治理掛鉤（v1 未寫，是討論中的技術方案） | 競品已經在用同一個 `tool.call` → 自家程式 → `tool.result` 接縫 | 照用，但**降為基本盤**，不當賣點講 |
| 6 | 多語言＝支援很多語言 | Universal-3.5 Pro 支援 18 語含中日英，招牌是**句中語碼轉換**；另有 **Contextual prompting** 可餵領域術語 | 主打**語碼轉換**與**政策語言中立**，不比語言數量 |
| 7 | 未定義哪些 action 是真的 | 語料庫盤點：110 支中**只有 6 支持有外部憑證**（Google／Telegram／瀏覽器），**零支**持有蝦皮／Momo／Meta Ads／Google Ads | 明確宣告 real adapter vs sandbox adapter，寫進 UI 和 README |

---

## 1. 一句話

> **Voice Action Gate keeps the human _in_ the loop. Signal Box puts the human _on_ it.**
>
> One sentence, spoken once, governs a workforce that keeps running after you stop talking.

中文版：

> **一句話說出的規則，會活下去、會被遵守、會被修改——而且管的是你沒在跟它講話的那些 agent。**

---

## 2. 問題

Agent governance 目前有兩個極端：

- **全自動**：agent 決定、agent 執行。快，但會錯誤下架、發錯優惠、燒掉預算、對大量顧客做不可逆操作。
- **每步問**：agent 提案、人按同意，循環。安全，但 agent 的價值歸零。

第三種模式是本案的命題：

> **Humans define the boundaries. Agents operate autonomously inside them.**

但這句話在 2026 年已經不夠了，因為別人也在講類似的話。真正沒被解決的是**時間**：

當人講完話、離開現場之後，那句話還算不算數？誰記得它？它能不能被修改？被誰？改完之後正在跑的任務要不要重新評估？

**Signal Box 要解的是這個。**

---

## 3. 與 Voice Action Gate 的差異（必須寫清楚，評審會同時看到兩件）

| | Voice Action Gate | Signal Box |
|---|---|---|
| 語音產生什麼 | **一個動作** | **一份政策** |
| 執行時人在哪 | **在場**，正在對話 | **不在場**，workforce 非同步跑 |
| 擋什麼 | **參數的來源**——每個參數要能追回使用者真的講過的話 | **授權**——參數全對、轉錄無誤，仍可被擋 |
| 回答的問題 | 「你真的講了 500 嗎？」 | 「你講了 500、轉錄也對，**但今天你說過不能超過五千**」 |
| 政策壽命 | 無，一次性 | **有版本、可修改**（v1→v2 任務中途） |
| 治理對象 | 一個模擬轉帳 | **一支既有的多 agent workforce** |
| 失效模式 | 模型捏造參數 | 做了人不想要的事 |

**兩者互補，不衝突。** Pitch 可以大方講：他們守參數來源那一層，我們守授權那一層，嚴肅的系統兩層都要。這比假裝沒看到更有說服力，也讓評審更容易理解我們在哪一格。

**紀律**：介面與文件避免使用 gate 作為主要名詞。內部術語可用 interceptor / evaluator。

### 3.1 競品的已知缺口（來自其 `docs/ARCHITECTURE.md`，非推測）

該專案的架構文件自行揭露三項缺口，均為原文載明：

| 缺口 | 原文 | 對我們的意義 |
|---|---|---|
| **端到端從未跑過** | *"a true end-to-end run — browser microphone → Worker mints → websocket → transcript → gate — has never been executed. It needs a physical microphone."* | **Application of Technology 上可超車的最大空間。** 我們必須真的用麥克風跑通，並錄進影片 |
| read-back 未實作 | `READ_BACK_CONFIRMED` 是「a `CheckId` with no checker behind it」，自述為 *"an interface slot, not a feature"* | 對照組：我們的 ASK 路徑要真的能問、能等、能收回答 |
| **非英文輸入未測** | ❓ *"whether non-English input produces zero witnesses rather than failing silently (V-4)"* | 其正規化器為英文中心（`"five hundred"`→500）。中文「五百」、日文「五千」是不同解析路徑。**多語言是對手方法論的已知弱點，不只是我們的加分項** |

### 3.2 值得採用的紀律

該文件的**證據分級表**值得照抄：✅ Confirmed／✅ Measured／⚠ 已量測但樣本域不符／❓ Not measured／🔴 假設非結論。並且把**自我推翻**寫進文件（他們撤回過兩項先前宣稱）。

對工程背景的評審，這種紀律本身就是說服力。本案 README 與架構文件比照辦理。


---

## 4. 使用者

**主要角色**：中小型電商品牌的 Founder／營運負責人。

他已經有大量 AI automation。他要的不是操作 AI 工具，是**管理 AI workforce**。他真實的一天：早上出門前講一句話，中午在外面收到一則「有 14 筆已付款訂單要怎麼處理」，回一句語音，晚上回辦公室看整天發生了什麼。

**這決定了介面形態**（見 §8）：手機是**下指令**的介面，桌機是**看全局**的介面。

---

## 5. 核心原則

> **Autonomy inside the boundary. Human authorization at the boundary.**

Agent 可自主：Read／Search／Analyze／Reason／Draft／Recommend／Plan

受治理：Publish／Send／Pause／Change／Spend／Discount／Refund／Cancel／Delete

### 風險分級

| Level | 類型 | 範例 | 預設 |
|---|---|---|---|
| L0 | Reason | 分析資料 | AUTO |
| L1 | Read | 查庫存、ROAS | AUTO |
| L2 | Draft | 草擬 EDM | AUTO |
| L3 | External Write | 發 LINE、發布商品、暫停廣告 | POLICY |
| L4 | Financial / Destructive | 預算、退款、取消訂單、刪除 | **APPROVAL（預設 ASK，不由 LLM 決定）** |
| **L4-meta** | **產生未來自主執行** | **建立排程（C10）** | **APPROVAL** |

**L4-meta 是這一版新增的，來自語料庫分析。** C10 排程被 46 支 skill 依賴，是全庫第二大樞紐。排程是**元動作**：它不直接造成後果，但會製造「未來在無人時自主執行」的能力——等於 policy 的逃生門。一個只擋直接動作的治理層，會被「排一個明天早上八點執行的任務」整個繞過。

---

## 6. 語音層

### 6.1 路徑選擇：Voice Agent API（主）

理由：端到端單一連線、內建 turn-taking 與 VAD、**JSON-Schema tool calling**。「ASK」路徑天然就是 turn-taking——系統開口問、等人回答、VAD 判斷講完了。

**治理工具註冊為 client-side function tools**：

- `compile_policy(rules[])` — 把授權編成結構化政策
- `amend_policy(policy_id, changes[])` — 任務中途修改
- `answer_pending(action_id, verdict)` — 回答系統的提問
- `explain_decision(action_id)` — 解釋為什麼擋

政策**不是**靠 LLM 自由發揮再去 parse，而是由 tool call 的 schema 保證結構。這落實 SDD 的 LLM Boundary：LLM 負責理解語言，**最終授權由結構化政策 + 確定性 evaluator 決定**。

### 6.2 多語言：中／英／日

**不打「支援很多語言」這張牌**，打兩張更硬的：

**(a) 句中語碼轉換。** 台灣電商老闆的真實語言長這樣：

> 「ROAS 低於 1 的先 **pause** 掉，蝦皮那邊 **delist**，但 campaign B 表現好可以加 budget，不要超過五千。」

一句話混兩種語言，而且英文詞正好是平台術語。這是 Universal-3.5 Pro 的頭號功能（**no config，自動**），而且是真實情境不是硬湊。

**(b) 政策是語言中立的。** 同一份規則用中文、英文、日文講，**編出來的 policy 物件完全相同**。Demo 時三語各講一次，跑出同一個 fingerprint。

**Contextual prompting**：預先餵入領域術語（蝦皮／Momo／ROAS／delist／pause_ad／skill 代號），拉高混語辨識率。

**韓文與台語**：韓文不在 18 語清單內，**拿到 key 後實測再決定，未經實測不得寫進任何對外文件**。台語不支援——但**不當缺陷處理**：轉錄信心不足時**拒絕編譯政策、回頭問人**，這正好是安全原則的展示。

### 6.3 歧義處理

人說「其他照常」而系統不確定「其他」指什麼時，**不准猜**。信心低於門檻就回問，確認後才更新政策。

---

## 7. 治理層

### 7.1 政策模型

```json
{
  "policy_id": "P-2026-001",
  "mission_id": "M-100",
  "version": 2,
  "scope": { "type": "mission" },
  "rules": [
    { "action": "pause_ad", "effect": "ALLOW" },
    { "action": "delist_product", "effect": "ALLOW" },
    { "action": "notify_customer", "effect": "ALLOW",
      "conditions": { "customer_group": "paid_affected" } },
    { "action": "cancel_order", "effect": "DENY" },
    { "action": "issue_refund", "effect": "DENY" },
    { "action": "increase_ad_budget", "effect": "ALLOW",
      "conditions": { "increase_percent": { "lte": 20 },
                      "daily_total": { "lte": 5000 } },
      "otherwise": "ASK" }
  ]
}
```

### 7.2 生命週期（這是差異化的核心，要做紮實）

| Scope | 觸發語 | 存活範圍 | MVP |
|---|---|---|---|
| Mission | 「這次可以」 | 單一任務 | **P0** |
| Session | 「今天都照這個規則」 | 當日 | **P0** |
| Organization | 「以後超過五千都問我」 | 持久 | P2（只展示 schema） |

**修改而非重建**：人說「那 14 個已付款的可以通知」時，是對現有政策做 diff，不是開新任務。版本號遞增，稽核記錄綁定版本。

### 7.3 決策引擎（確定性，不含 LLM）

```
動作 + 政策 + 情境
  ↓
1. action 有在 registry 裡嗎？   否 → ASK
2. 有明確 DENY 嗎？             是 → DENY
3. 有明確 ALLOW 嗎？            是 → 檢查條件
4. 條件成立嗎？                 是 → ALLOW ／ 否 → ASK
5. 無任何規則命中                → L4：ASK；其餘：DENY
```

### 7.4 不變式

> **No consequential action reaches an adapter except through the evaluator.**

語料庫分析證明這件事是**可達成**的：4 隻 subagent（copywriter／analyst／crawler／judge）全部只回傳結果給主 skill，**沒有任何一隻能執行外部寫入**。外部副作用全部收斂到「主 skill → 連接器」這一條，攔截面是可枚舉的小集合。

**要有一支測試釘住它**：掃描原始碼，任何 adapter 呼叫不經 evaluator 就紅。（此為本案的 mutation-arm 對應物。）

---

## 8. 介面

### 8.1 Application URL：Governance Canvas（P0，交件必需）

一張畫布，節點是 workforce 的 skill，連線是真實的依賴關係，**行動請求在線上流動**，經過評估後或放行、或停住。

**RWD 不是縮放，是換角色**：

- **手機**＝下指令。語音鈕、待決事項卡、批准／拒絕、執行報告
- **桌機**＝看全局。整張畫布、政策面板、稽核軌跡

### 8.2 互動證明（向競品學的，必做）

畫布上提供「**試著繞過**」控制：評審自己嘗試偽造一個被禁止的呼叫，看著它在 evaluator 前停住。

**互動證明遠比動畫有說服力。** 這是競品做對而我們原型還沒做的一點。

### 8.3 執行報告

透過原 channel 回報：已執行、已阻擋、阻擋原因、待決事項，並提供**語音回覆**入口。

---

## 9. Capability Registry 與誠實邊界

### 9.1 registry 收錄什麼

`skill_id / domain / action / side_effect / risk / reversible / financial / customer_impact / dependencies / adapter_kind`

來源：v7 語料庫 110 支的**衍生 metadata**（代號、動作名、風險級、依賴關係）。**SKILL.md 全文不進 repo。**

### 9.2 誠實邊界（寫進 README、UI、簡報）

語料庫盤點結果：

- 110 支中**只有 6 支宣告外部憑證**：C02 google-connect、C02 ga4-connect、C03 telegram-bot、C05 sandbox-browser、C07 sheets-database、C08 drive-manager
- **零支**持有蝦皮／Momo／Meta Ads／Google Ads 憑證
- C05 沙盒瀏覽器明文寫「不要用於需要登入的頁面」——**無法登入平台後台**

**因此**：

| Adapter | 動作 | 狀態 |
|---|---|---|
| Real | Google Sheets 寫入、Gmail 寄送、Drive 操作、Telegram 送訊息、LINE 推播 | 真實 API |
| **Sandbox** | `pause_ad`、`delist_product`、`cancel_order`、`issue_refund` | 模擬 |

**Governance engine 本身是真的。** 這句話要能被驗證，而不是被相信。

> 紀律：沒量過的數字不寫。沒有證據的宣稱寫「design intent」，不寫「it cannot」。

---

## 10. Hero Demo：Voice-Governed Emergency Commerce Operations

**觸發**：熱銷商品庫存耗盡 → E03 庫存預警 → E77 異常偵測 → E87 緊急更新，扇出 8 項行動。
（此依賴鏈取自 E87 自己宣告的 `依賴關係`，非杜撰。）

**語音授權**（即時連線）：

> 「Meta 跟 Google 廣告全部先 pause 掉，蝦皮跟官網可以 delist，但先不要通知客人。訂單不要取消，退款也不能自己做。已付款的訂單先整理給我。」

**編譯** → P-2026-001 v1

**執行**：6 項放行、2 項擋下。

**Hero moment**：E27 嘗試 `notify_customer(all)` → **停在 evaluator 前**，未抵達 LINE Messaging API。

**回報並詢問**：「顧客通知被你的政策禁止，因此沒有發送。有 14 筆已付款訂單，要怎麼處理？」

**語音修改**：

> 「那 14 個已付款的客人可以通知，但還是不要取消訂單，退款也一樣不行。」

**政策 v2** → `notify_customer` 加上條件 `group=paid_affected` → **恢復執行**。

**收尾**：8 項請求 · 6 放行 · 2 擋下。取消訂單與退款自始至終未獲授權，也從未執行。

**三語重跑**：中／英／日各講一次，**policy fingerprint 不變**。

---

## 11. 交件物 × 評分對應

| 必交項 | 我們的東西 |
|---|---|
| Project title / descriptions / tags | Signal Box |
| Cover image | 畫布的攔截瞬間 |
| **Video presentation** | ≤5 分鐘：30 秒講清 on-the-loop，再跑 Hero Demo |
| **Slide presentation** | PDF |
| **Public GitHub repository** | MIT，含 registry、evaluator、adapters、測試 |
| **Demo application platform / Application URL** | Governance Canvas（部署上線） |

| 評分項 | 主打 |
|---|---|
| **Application of Technology** | Voice Agent API 即時串流 + JSON-Schema tool calling + 語碼轉換 + contextual prompting + LLM Gateway |
| **Presentation** | 畫布看得到「正在跑」＋ 評審可自己試著繞過 |
| **Business Value** | 真實的錢：廣告預算、訂單、退款；治理的是既有 workforce 不是玩具 |
| **Originality** | 語音編譯出**有生命週期的政策**；on the loop；政策語言中立 |

---

## 12. 範圍

### P0（必做）

- Capability Registry v1（110 支衍生 metadata）
- 確定性 Policy Evaluator（ALLOW／DENY／ASK）
- Policy Compiler（Voice Agent API tool calling）
- Policy 生命週期：mission + session scope、版本、修改
- Action Interceptor + 不變式測試
- Adapters：real（Google／Telegram／LINE）+ sandbox（廣告／上架／訂單／退款）
- **Governance Canvas（Application URL）** + 互動繞過測試
- 稽核軌跡
- E87 Hero Workflow
- 新英文 skill pack 12–20 支
- 三語（中／英／日）

### P1

- LINE / Telegram 語音訊息第二入口
- E60 廣告治理 Demo（條件式授權：ROAS<1 可停、加預算 ≤20%、日總額 ≤5000 要問）
- Agent 活動時間軸

### P2（賽後）

- 持久組織政策、RBAC、多人審批、語音身分
- Shopify / Meta Ads 正式串接
- 政策版本管理與合規

---

## 13. 26 天時程

| 期間 | 目標 | 完成判準 |
|---|---|---|
| **9/4–9/6** | Registry v1 + Action schema + Evaluator | 單元測試綠；不變式測試存在 |
| **9/7–9/10** | Voice Agent API 接通 + Policy Compiler | **第一個技術里程碑**（見下） |
| **9/11–9/14** | 生命週期、修改、稽核 | v1→v2 修改可跑 |
| **9/15–9/19** | Governance Canvas + RWD + 互動繞過 | 手機與桌機都能操作 |
| **9/20–9/23** | 英文 skill pack + adapters + E87 Hero | 端到端跑通 |
| **9/24–9/26** | 三語 + contextual prompting + 韓文實測 | 三語同一 fingerprint |
| **9/27–9/28** | 影片 + 簡報 + README + 部署 | 全部必交項齊備 |
| **9/29** | 緩衝 | — |
| **9/30** | 交件（23:00 TST） | — |

### 第一個技術里程碑（9/10 前必須跑通）

```
真人講話 → AssemblyAI 即時串流 → tool call → policy JSON
        → agent 送出 action → evaluator → BLOCKED
```

**這條不通，其他都不用做。** 不要先做畫布。

---

## 14. 待決事項

1. **韓文** — 拿 key 實測 Universal-3.5 Pro 是否支援。未實測前不對外宣稱。
2. **產品名** — 目前 Signal Box（避開 gate）。需確認商標無衝突。
3. **英文 skill pack 的平台選擇** — Shopify / Amazon / Meta Ads / Klaviyo？需與 registry 的 action 命名對齊。
4. **團隊** — 1–6 人。是否找人補影片剪輯與簡報。
5. **舊 ZIP 差異** — 使用者曾提及 C 系列 13 支、D 系列 3 支；本機 v7 為 C 12、D 2。若另有版本需先合併再定 registry 範圍。

---

## 附錄 A：語料庫盤點事實（v7，110 支）

- 組成：92 E（電商／行銷／SEO）、12 C（基礎設施／連接器）、2 D（初始化／品牌）、4 SA（通用 subagent）
- 91 支宣告了 `依賴關係`
- 被依賴 Top 3：**C07 Sheets（47）、C10 排程（46）、C05 瀏覽器（24）**
- 扇出 Top：E58（8）、E30／E64（7）、E20／E27／E60／E68／E81／E82／E87（6）
- 4 隻 subagent 皆為通用型（文案／數據／爬蟲／判斷），由主 skill 注入 `[PERSONA]`，**均無外部寫入能力**

**這一節是「我們治理的是一個真實存在的 workforce」的證據，不是行銷文案。**
