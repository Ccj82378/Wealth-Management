# Wealth Dashboard

> 個人投資組合管理系統 · All Weather 策略 · 即時數據串接

---

## 系統概覽

基於 Ray Dalio All Weather 投資框架的個人資產追蹤與決策輔助系統。

```
Google Sheets（數據層）
  → Apps Script（API 橋接）
    → Next.js / Vercel（Dashboard 展示層）
      → 手機 / 電腦瀏覽器
```

**核心功能：**
- 即時持倉追蹤（台股 + 美股，自動換算 TWD）
- All Weather 三類配置（Growth / Inflation / Deflation）缺口分析
- 月定投計劃（DCA）+ 戰略部署建議（Step 1 / Step 2）
- 多標的加倉模擬（含未持有標的）
- 被動收益估算（利息 + 股息）
- 經濟象限自動判斷（SPY + RINF，雙軌窗口）
- 匯率趨勢監控（USD/TWD 90天比較）
- 風控警示（停損 / 部位過重 / 失衡 / 現金水位 / 匯率曝險）
- 已實現績效追蹤（年化報酬率 + 年化 Alpha）

---

## 技術架構

### Stack
- **Frontend：** Next.js 16.2.4（App Router）
- **Language：** TypeScript（strict: false）
- **Styling：** Inline styles + Google Fonts
- **Deploy：** Vercel（GitHub 連動自動部署）
- **Data：** Google Sheets + Apps Script API

### 檔案結構
```
wealth-dashboard/
├── app/
│   ├── api/sheets/route.js    ← Apps Script 中介 API（60秒快取）
│   ├── page.tsx               ← 主 Dashboard（單頁五個 Tab）
│   ├── layout.tsx
│   └── globals.css
├── .env.local                 ← 環境變數（不推上 GitHub）
├── tsconfig.json              ← strict: false
└── package.json
```

### 環境變數（.env.local）
```
APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
APPS_SCRIPT_TOKEN=jun_portfolio_2026
```

---

## 本地開發

```bash
# 進入專案
cd C:\Users\jason\Desktop\wealth-dashboard

# 啟動開發伺服器
npm run dev

# 瀏覽器開啟
http://localhost:3000        # Dashboard
http://localhost:3000/api/sheets  # API 測試

# 新開終端（不關 dev server）
Ctrl + Shift + `
```

---

## 部署

```bash
# 推上 GitHub → Vercel 自動部署（約 1-2 分鐘）
git add .
git commit -m "描述改了什麼"
git push
```

**Vercel 網址：** `wealth-management-eta.vercel.app`

**Vercel 環境變數設定：**
Settings → Environment Variables → 加入 `APPS_SCRIPT_URL` 和 `APPS_SCRIPT_TOKEN`

---

## Google Sheets 結構

**檔案：** `portfolio_log_v2`（Google Sheets）

| 分頁 | 用途 |
|------|------|
| Trade Log | 每筆交易手動輸入 |
| Capital Log | 薪資 / 股息 / 銀行餘額快照 |
| Realized Performance | 已出場標的績效 |
| Settings | 所有參數 + 即時數據（GOOGLEFINANCE）|

**Settings 八個區塊：**
1. All Weather 配置目標（三類佔比）
2. 執行參數（DCA 金額 / 定投標的分配 / 部署金額）
3. 資金與目標（不可動用現金 / 目標淨資產）
4. 風控參數（停損線 / 部位上限 / 警戒線）
5. 標的清單（Ticker / 名稱 / 幣別 / 類別 / 殖利率）
6. 銀行利率（各銀行年利率）
7. 即時市場數據（GOOGLEFINANCE 股價 / 匯率）
8. 經濟象限自動判斷（SPY + RINF 雙軌窗口 + 匯率趨勢）

**注意：** 台股 Ticker 格式統一為 `006208`、`00878`，不是 `6208`、`878`。

---

## Apps Script API

**Endpoint：** `GET /api/sheets`（Next.js 中介層）

**回傳格式：**
```json
{
  "Trade Log": [["DATE","Ticker",...], [...], ...],
  "Capital Log": [["Date","Type",...], [...], ...],
  "Realized Performance": [["Ticker",...], [...], ...],
  "Settings": { "key": value, ... },
  "Tickers": [{"ticker","name","currency","category","yield"}, ...],
  "Banks": [{"name","rate"}, ...]
}
```

**更新 Apps Script 流程：**
1. Google Sheets → 擴充功能 → Apps Script
2. 修改程式碼
3. 部署 → 管理部署作業 → 建立新版本
4. 更新 `.env.local` 和 Vercel 環境變數

---

## 關聯文件

| 文件 | 位置 | 說明 |
|------|------|------|
| 邏輯憲法 v3.8 | Google Drive | Single Source of Truth，所有計算邏輯定義 |
| portfolio_log_v2 | Google Sheets | 數據主檔 |
| SKILL.md | Google Drive | Claude 開發維護指引（L1~L5 框架）|

---

## 版本紀錄

### v3.9（2026-04-26）當前版本
**對應憲法：** investment_logic_v38.md

**UI 升級（Claude Design）：**
- Skeleton loading（載入時骨架屏，不再顯示空白）
- DonutChart（All Weather 配置圓環圖）
- LineChart（淨資產歷史折線圖，從 Capital Log bankRows 抓取）
- Card hover 效果（滑鼠懸停微浮起）
- Row hover 效果（持倉 / 績效列 hover 高亮）
- Tab 記憶（localStorage 記住上次瀏覽的 Tab）

### v3.8（2026-04-25）當前版本
**對應憲法：** investment_logic_v38.md

**新功能：**
- 經濟象限顯示升級：成長方向↑↓ + 通膨方向↑↓ + 象限名稱 + 確認狀態
- 匯率趨勢顯示（USD/TWD 90天比較，台幣升貶值方向）
- 7.6 匯率風險警示（美元資產佔比超過警戒線觸發）
- 模擬升級：支援 Tickers 清單所有標的 + 手動輸入任意標的
- 再平衡改為 Step 1（DCA）/ Step 2（戰略部署）明確分區
- 戰略部署建議改為平均分配（修正 QQQM、VOO 不顯示的問題）

**Bug 修正：**
- Ticker 格式統一為 006208 / 00878（移除 displayTicker 轉換邏輯）
- DCA 股數顯示 0（修正 getPrice 讀取 key 格式）
- 利息計算邏輯修正（加權平均利率 × 總餘額）

**畫面優化：**
- 風險警示直接顯示，不折疊
- KPI 五格（含目標達成率 + 年化收益率）
- 持倉配置% 移到名稱下方小字
- 桌面 5 格 KPI / 手機 2×3

---

### v3.7（2026-04-22）
**對應憲法：** investment_logic_v37.md

**主要改動：**
- 經濟象限指標：成長改用 SPY（穩定，不易 N/A）
- 通膨指標：TIP → RINF（直接追蹤通膨預期 BEI）
- 比較窗口：30 天 → 60 + 180 天雙軌窗口
- 象限確認機制：兩個窗口方向一致才確認，過渡期維持現有配置
- Settings 區塊八更新（RINF 公式 + 雙軌窗口 + 匯率趨勢）
- 新增 7.6 匯率風險警示規則
- 美元資產警戒線加入 Settings 區塊四

---

### v3.6（2026-04-22）
**對應憲法：** investment_logic_v36.md

**主要改動：**
- 經濟象限判斷從台股（^TWII）改為美股（^GSPC / SPY）
- 通膨指標從 ^TNX（GOOGLEFINANCE 不支援）改為 TIP
- 比較窗口 30 天
- Dashboard 初版完成並部署至 Vercel

---

### v3.5（2026-04-21）
**對應憲法：** investment_logic_v35.md

**主要改動：**
- 憲法新增 1.8 系統主導原則（四層決策優先順序）
- 憲法新增 3.6 經濟四象限（Macro Regime Layer）
- 憲法新增 3.7 Deflation 補強（Bond Layer）
- 憲法新增 7.6 決策優先級
- 憲法新增 7.7 Stress Regime 極端情境防禦
- Next.js 專案建立，API 串接 Apps Script 完成
- Dashboard 五個 Tab 初版上線

---

### v3.4（2026-04-21）
**對應憲法：** investment_logic_v34.md

**主要改動：**
- 憲法重大改版：數據與邏輯分離（具體數值移至 Settings）
- 新增 1.7 數據來源分層原則
- 標的清單、殖利率、銀行利率全部移出憲法
- Settings 分頁七個區塊定義完整化
- Realized Performance 新增 Annualized Return % 和 Annualized Alpha

---

### v3.3（2026-04-20）
**對應憲法：** investment_logic_v33.md

**主要改動：**
- 資產分層框架（Tier 1~4）新增
- Trade Log 新增 Total Amount TWD 欄位
- 年度功能新增機會成本基準報酬率（VOO）
- 組合簡單報酬率補充除以零防護

---

### v1.0（2026-04-19）初版
- Portfolio Log 建立（Trade Log / Capital Log / Realized Performance / Settings）
- 基本交易記錄 29 筆
- Apps Script API 初版
- Google Sheets GOOGLEFINANCE 即時數據串接

---

## 日常使用 SOP

### 記錄新交易
1. Google Sheets → Trade Log → 新增一行
2. Ticker 格式：台股 ETF 填 `006208`（非 `6208`），個股填 `2059`
3. 買入 Tax 填 0，賣出填實際稅額
4. FX Rate：TWD 標的填 `1`，USD 標的填當日匯率
5. Capital Log 同步更新銀行餘額（Type: Bank Update）

### 每月維護
1. Capital Log 記錄薪資 / 股息入帳
2. 對帳後更新銀行餘額快照
3. 查看 Dashboard → 再平衡 Tab 執行 DCA + 戰略部署

### 年度維護
1. 殖利率校正（Settings 區塊五，差異 > 10% 更新）
2. 機會成本基準年報酬率（Settings 區塊三，填入同期 VOO 報酬）
3. Realized Performance 確認年化 Alpha

---

## 常見問題

| 問題 | 解法 |
|------|------|
| Dashboard 無法載入 | 確認 `npm run dev` 有跑，或 Vercel 部署正常 |
| 數字沒更新 | 點 ↻ 更新，GOOGLEFINANCE 約 15-20 分鐘更新一次 |
| 某標的市值顯示 0 | 確認 Settings 區塊七現價公式正常，Ticker 格式正確 |
| DCA 股數顯示 0 | 確認 Settings 區塊七有 `006208現價` 和 `00878現價` |
| Vercel 部署失敗 | 確認 `tsconfig.json` 有 `"strict": false` |
| 經濟象限顯示過渡期 | 正常，SPY 和 RINF 短期長期方向不一致時顯示過渡期 |