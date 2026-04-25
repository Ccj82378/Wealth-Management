'use client';
import { useState, useEffect } from 'react';

const fmtTWD = (n: number) => `NT$ ${Math.round(n).toLocaleString('zh-TW')}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtNum = (n: number, d = 2) => Number(n).toFixed(d);
const toF = (v: unknown): number => parseFloat(String(v ?? '0').replace(/,/g, '')) || 0;

// Ticker 直接用原始值（已統一為 006208, 00878, 2059 等）
const getPrice = (cfg: Record<string, unknown>, ticker: string): number =>
  toF(cfg[`${ticker}現價`]) || 0;

const CAT_COLOR: Record<string, string> = {
  Growth: '#16a34a', Inflation: '#d97706', Deflation: '#2563eb'
};

interface Ticker { ticker: string; name: string; currency: string; category: string; yield: number; }
interface Bank { name: string; rate: number; }
interface Position extends Ticker {
  sh: number; costTWD: number; cp: number; mvTWD: number;
  pnlTWD: number; ret: number; avgCost: number; portPct: number;
}
interface AWRow { cat: string; tgt: number; cur: number; gap: number; gapAmt: number; }
interface SimRow {
  mode: 'list' | 'custom'; ticker: string; shares: number;
  customTicker: string; customPrice: number; customCurrency: string;
}

function usePortfolioData() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sheets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json); setLastUpdated(new Date()); setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '未知錯誤');
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchData(); }, []);
  return { data, loading, error, lastUpdated, refetch: fetchData };
}

function compute(data: Record<string, unknown> | null) {
  if (!data) return null;
  const cfg = (data.Settings || {}) as Record<string, unknown>;
  const tickers = (data.Tickers || []) as Ticker[];
  const banks = (data.Banks || []) as Bank[];
  const trades = ((data['Trade Log'] as unknown[][]) || []).slice(1);
  const caps = ((data['Capital Log'] as unknown[][]) || []).slice(1);
  const realized = ((data['Realized Performance'] as unknown[][]) || []).slice(1);

  const fx = toF(cfg['USD/TWD匯率']) || 31.48;
  const unavail = toF(cfg['不可動用現金']) || 300000;
  const awTargets: Record<string, number> = {
    Growth:    toF(cfg['Growth目標佔比'])    || 0.6,
    Inflation: toF(cfg['Inflation目標佔比']) || 0.2,
    Deflation: toF(cfg['Deflation目標佔比']) || 0.2,
  };
  const deployAmt = toF(cfg['月戰略部署金額']) || 100000;
  const targetNW  = toF(cfg['目標淨資產'])    || 5000000;
  const fixedDCA  = toF(cfg['月固定投入'])     || 10000;
  const dca6208Pct = toF(cfg['006208定投佔比']) || 0.7;
  const dca878Pct  = toF(cfg['00878定投佔比'])  || 0.3;

  // Positions — ticker 直接用 Tickers 清單的值 match Trade Log
  const positions: Position[] = tickers.map(t => {
    const tid = String(t.ticker);
    const buys  = trades.filter(r => String(r[1]) === tid && r[3] === 'Buy');
    const sells = trades.filter(r => String(r[1]) === tid && r[3] === 'Sell');
    const sh = buys.reduce((s, r) => s + toF(r[6]), 0)
             - sells.reduce((s, r) => s + toF(r[6]), 0);
    const costTWD = buys.reduce((s, r) => s + toF(r[12]), 0);
    if (sh <= 0) return null;
    const cp = getPrice(cfg, tid);
    const mvTWD = cp > 0 ? (t.currency === 'USD' ? cp * sh * fx : cp * sh) : costTWD;
    const pnlTWD = cp > 0 ? mvTWD - costTWD : 0;
    const ret = costTWD > 0 && cp > 0 ? pnlTWD / costTWD : 0;
    const avgCost = t.currency === 'USD' ? (costTWD / sh) / fx : costTWD / sh;
    return { ...t, sh, costTWD, cp, mvTWD, pnlTWD, ret, avgCost, portPct: 0 };
  }).filter(Boolean) as Position[];

  const totInv = positions.reduce((s, p) => s + p.mvTWD, 0);
  positions.forEach(p => { p.portPct = totInv > 0 ? p.mvTWD / totInv : 0; });

  const bankRows = caps.filter(r => toF(r[9]) > 0);
  const latestBank = bankRows.length > 0 ? toF(bankRows[bankRows.length - 1][9]) : 0;
  const avail = Math.max(0, latestBank - unavail);
  const base = avail + totInv;
  const netWorth = latestBank + totInv;

  const twdStocks = positions.filter(p => p.currency === 'TWD').reduce((s, p) => s + p.mvTWD, 0);
  const usdStocks = positions.filter(p => p.currency === 'USD').reduce((s, p) => s + p.mvTWD, 0);
  const twdTotal = latestBank + twdStocks;
  const usdTotal = usdStocks;
  const twdPct = netWorth > 0 ? twdTotal / netWorth : 0;
  const usdPct = netWorth > 0 ? usdTotal / netWorth : 0;

  const awCur: Record<string, number> = { Growth: 0, Inflation: 0, Deflation: avail };
  positions.forEach(p => { awCur[p.category] = (awCur[p.category] || 0) + p.mvTWD; });
  const awRows: AWRow[] = Object.entries(awTargets).map(([cat, tgt]) => ({
    cat, tgt,
    cur: base > 0 ? awCur[cat] / base : 0,
    gap: tgt - (base > 0 ? awCur[cat] / base : 0),
    gapAmt: (tgt - (base > 0 ? awCur[cat] / base : 0)) * base,
  }));

  // 利息：加權平均利率 × 總餘額
  const avgRate = banks.length > 0 ? banks.reduce((s, b) => s + b.rate, 0) / banks.length : 0;
  const annInt = latestBank * avgRate;
  const annDiv = positions.reduce((s, p) => s + p.mvTWD * (p.yield || 0), 0);
  const monthly = (annInt + annDiv) / 12;
  const annYield = base > 0 ? (annInt + annDiv) / base : 0;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthCaps = caps.filter(r => { const d = new Date(String(r[0])); return d >= monthStart; });
  const monthSalary   = monthCaps.filter(r => r[1] === 'Salary').reduce((s, r) => s + toF(r[2]), 0);
  const monthBonus    = monthCaps.filter(r => r[1] === 'Bonus').reduce((s, r) => s + toF(r[2]), 0);
  const monthDividend = monthCaps.filter(r => String(r[1]).startsWith('Dividend')).reduce((s, r) => s + toF(r[2]), 0);
  const monthOther    = monthCaps.filter(r => r[1] === 'Non-leaving pay').reduce((s, r) => s + toF(r[2]), 0);

  const goalPct = targetNW > 0 ? netWorth / targetNW : 0;
  const recent6 = bankRows.slice(-7);
  let monthlyGrowth = 0;
  if (recent6.length >= 2) {
    const diffs = [];
    for (let i = 1; i < recent6.length; i++) diffs.push(toF(recent6[i][9]) - toF(recent6[i-1][9]));
    monthlyGrowth = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  }
  const estMonths = monthlyGrowth > 0 ? Math.ceil((targetNW - netWorth) / monthlyGrowth) : null;

  // DCA
  const dcaPlan = [
    { ticker: '006208', name: '富邦台50', budget: fixedDCA * dca6208Pct, cp: getPrice(cfg, '006208') },
    { ticker: '00878',  name: '國泰ESG',  budget: fixedDCA * dca878Pct,  cp: getPrice(cfg, '00878') },
  ].map(d => ({ ...d, shares: d.cp > 0 ? Math.floor(d.budget / d.cp) : 0 }))
   .map(d => ({ ...d, amt: d.shares * d.cp, residual: d.budget - d.shares * d.cp }));

  // 警示
  const warns: string[] = [];
  const usdWarnLine = toF(cfg['美元資產警戒線']) || 0.5;
  if (usdPct >= usdWarnLine)
    warns.push(`美元資產佔比 ${fmtPct(usdPct)}，超過警戒線 ${fmtPct(usdWarnLine)}，建議評估匯率曝險`);
  positions.forEach(p => {
    const isETF = !['2059', '6584'].includes(p.ticker);
    const sl = isETF ? toF(cfg['ETF停損線']) || -0.25 : toF(cfg['個股停損線']) || -0.15;
    if (!isETF && p.ret >= (toF(cfg['個股報酬達標線']) || 0.8))
      warns.push(`${p.ticker} 報酬率達 ${fmtPct(p.ret)}，建議評估出場`);
    if (p.ret <= sl)
      warns.push(`${p.ticker} 跌破停損線（${fmtPct(p.ret)}），建議檢視`);
    if (p.portPct >= (toF(cfg['單一標的上限']) || 0.35))
      warns.push(`${p.ticker} 佔組合 ${fmtPct(p.portPct)}，超過上限`);
  });
  awRows.forEach(r => {
    if (Math.abs(r.gap) >= (toF(cfg['失衡警戒幅度']) || 0.15))
      warns.push(`${r.cat} 偏離目標 ${fmtPct(Math.abs(r.gap))}，建議再平衡`);
  });
  if (latestBank > 0 && avail <= (toF(cfg['現金水位警戒線']) || 500000))
    warns.push(`可動用現金 ${fmtTWD(avail)}，低於警戒線`);

  // 經濟象限 & 匯率
  const growthS  = String(cfg['成長方向(短期)'] || '');
  const inflS    = String(cfg['通膨方向(短期)'] || '');
  const quadrant    = String(cfg['當前象限']     || '—');
  const quadConfirm = String(cfg['象限確認']     || '');
  const stressStatus = String(cfg['Stress Regime狀態'] || '—');
  const fxTrend  = String(cfg['匯率趨勢']        || '');
  const totPnL = positions.reduce((s, p) => s + p.pnlTWD, 0);

  const realizedRows = realized.map(r => ({
    ticker: r[0], instrument: r[1], holdingDays: toF(r[7]),
    buyCost: toF(r[8]), sellValue: toF(r[9]), pnlTWD: toF(r[10]),
    returnPct: toF(r[11]), annReturn: toF(r[12]),
    benchmark: toF(r[13]), annAlpha: toF(r[15]), notes: String(r[16] || ''),
  }));

  return {
    cfg, fx, tickers, positions, totInv, latestBank, avail, base, netWorth,
    twdTotal, usdTotal, twdPct, usdPct,
    awRows, awCur, awTargets, totPnL, monthly, annInt, annDiv, annYield,
    goalPct, estMonths, targetNW, deployAmt, fixedDCA,
    warns, growthS, inflS, quadrant, quadConfirm, stressStatus, fxTrend,
    realizedRows, dcaPlan,
    monthSalary, monthBonus, monthDividend, monthOther,
  };
}

export default function Dashboard() {
  const { data, loading, error, lastUpdated, refetch } = usePortfolioData();
  const [tab, setTab] = useState('overview');
  const [mounted, setMounted] = useState(false);
  const [simRows, setSimRows] = useState<SimRow[]>([
    { mode: 'list', ticker: 'QQQM', shares: 5,  customTicker: '', customPrice: 0, customCurrency: 'USD' },
    { mode: 'list', ticker: 'VOO',  shares: 2,  customTicker: '', customPrice: 0, customCurrency: 'USD' },
  ]);

  useEffect(() => { setTimeout(() => setMounted(true), 150); }, []);
  const c = compute(data);

  if (loading) return (
    <div style={{ minHeight:'100vh', background:'#f7f6f3', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, fontFamily:'system-ui' }}>
      <div style={{ width:32, height:32, border:'2.5px solid #e6e2dc', borderTop:'2.5px solid #1a1a1a', borderRadius:'50%', animation:'spin .8s linear infinite' }} />
      <div style={{ fontSize:15, color:'#555' }}>載入數據中…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
  if (error) return (
    <div style={{ minHeight:'100vh', background:'#f7f6f3', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, fontFamily:'system-ui', padding:32 }}>
      <div style={{ color:'#dc2626', fontSize:15 }}>⚠ 無法載入：{error}</div>
      <button onClick={refetch} style={{ padding:'10px 24px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:4, cursor:'pointer', fontSize:15 }}>重試</button>
    </div>
  );
  if (!c) return null;

  const TABS = [['overview','總覽'],['positions','持倉'],['rebalance','再平衡'],['simulate','模擬'],['realized','績效']];

  // Simulation
  const simResults = simRows.map(row => {
    let ticker: string, currency: string, cp: number, name: string;
    if (row.mode === 'custom') {
      if (!row.customTicker || row.customPrice <= 0) return null;
      ticker = row.customTicker.toUpperCase();
      currency = row.customCurrency;
      cp = row.customPrice;
      name = ticker;
    } else {
      const tk = c.tickers.find(t => String(t.ticker) === row.ticker);
      if (!tk) return null;
      ticker = String(tk.ticker);
      currency = tk.currency;
      cp = getPrice(c.cfg, ticker);
      name = tk.name;
      if (cp <= 0) return null;
    }
    const qty = Number(row.shares) || 0;
    if (qty <= 0) return null;
    const pTWD = currency === 'USD' ? cp * c.fx : cp;
    const buyAmt = pTWD * qty;
    const ep = c.positions.find(p => p.ticker === ticker);
    const origCost = ep ? ep.costTWD : 0;
    const origSh   = ep ? ep.sh      : 0;
    const origPnL  = ep ? ep.pnlTWD  : 0;
    const origRet  = ep ? ep.ret     : 0;
    const origAvg  = ep ? ep.avgCost : 0;
    const nCost = origCost + buyAmt;
    const nSh   = origSh   + qty;
    const nAvgTWD = nSh > 0 ? nCost / nSh : 0;
    const nAvg = currency === 'USD' ? nAvgTWD / c.fx : nAvgTWD;
    const nMV  = pTWD * nSh;
    const nPnL = nMV - nCost;
    const nRet = nCost > 0 ? nPnL / nCost : 0;
    const category = ep?.category || (c.tickers.find(t => t.ticker === ticker)?.category || '');
    return { ticker, name, currency, cp, pTWD, buyAmt, qty, origCost, origSh, origPnL, origRet, origAvg, nAvg, nSh, nMV, nPnL, nRet, category };
  }).filter(Boolean) as {
    ticker:string; name:string; currency:string; cp:number; pTWD:number; buyAmt:number; qty:number;
    origCost:number; origSh:number; origPnL:number; origRet:number; origAvg:number;
    nAvg:number; nSh:number; nMV:number; nPnL:number; nRet:number; category:string;
  }[];

  const simTotal   = simResults.reduce((s, r) => s + r.buyAmt, 0);
  const simNewBase = c.base + simTotal;
  const simNewAW: Record<string, number> = { ...c.awCur };
  simResults.forEach(r => { if (r.category) simNewAW[r.category] = (simNewAW[r.category] || 0) + r.buyAmt; });

  return (
    <div style={{ minHeight:'100vh', background:'#f7f6f3', fontFamily:"'DM Sans', system-ui", color:'#1a1a1a' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        html{-webkit-text-size-adjust:100%}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
        .serif{font-family:'Libre Baskerville',Georgia,serif}
        .card{background:#fff;border:1px solid #e6e2dc;border-radius:6px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.05)}
        .lbl{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#666;margin-bottom:10px}
        .tab-btn{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:14px 16px;border:none;background:none;cursor:pointer;color:#666;border-bottom:2.5px solid transparent;transition:all .2s;white-space:nowrap}
        .tab-btn.active{color:#1a1a1a;border-bottom-color:#1a1a1a}
        .tab-btn:hover:not(.active){color:#333}
        .bdg{font-size:11px;font-weight:700;padding:3px 9px;border-radius:3px}
        .buy{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
        .over{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
        .ok{background:#f0f9ff;color:#0284c7;border:1px solid #bae6fd}
        .bar{background:#e8e4de;height:5px;border-radius:3px;overflow:hidden}
        .bf{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.4,0,.2,1)}
        .inp{font-family:'DM Sans',system-ui;font-size:14px;background:#faf9f7;border:1.5px solid #e6e2dc;color:#1a1a1a;padding:9px 12px;border-radius:4px;width:100%;outline:none}
        .inp:focus{border-color:#1a1a1a;background:#fff}
        .bp{font-family:'DM Sans',system-ui;font-size:13px;font-weight:600;padding:9px 16px;border-radius:4px;cursor:pointer;background:#1a1a1a;color:#fff;border:none}
        .bd-r{font-family:'DM Sans',system-ui;font-size:12px;padding:7px 11px;border-radius:4px;cursor:pointer;background:none;border:1.5px solid #fecaca;color:#dc2626}
        .hr{border:none;border-top:1px solid #e6e2dc;margin:16px 0}
        .step-tag{font-size:10px;font-weight:700;letter-spacing:.1em;padding:3px 8px;border-radius:2px;text-transform:uppercase}
        .wc{background:#fefce8;color:#713f12;border:1px solid #fde68a;border-radius:4px;padding:9px 14px;font-size:13px;font-weight:500;line-height:1.4}
        @keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .fu{animation:fu .3s ease forwards}
        @media(max-width:680px){
          .g4{grid-template-columns:1fr 1fr!important}
          .g5{grid-template-columns:1fr 1fr!important}
          .g2{grid-template-columns:1fr!important}
          .ptable{grid-template-columns:80px 1fr 90px 74px 54px!important}
        }
        @media(min-width:681px){.g5{grid-template-columns:repeat(5,1fr)!important}}
      `}</style>

      {/* Header */}
      <div style={{ background:'#fff', borderBottom:'1px solid #e6e2dc', position:'sticky', top:0, zIndex:100 }}>
        <div style={{ maxWidth:960, margin:'0 auto', padding:'0 16px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'15px 0 0', gap:12 }}>
            <div>
              <div style={{ fontSize:10, letterSpacing:'.14em', textTransform:'uppercase', color:'#999', marginBottom:3 }}>Investment OS · Live</div>
              <div className="serif" style={{ fontSize:20, fontWeight:700, lineHeight:1.2 }}>Portfolio Dashboard</div>
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div style={{ fontSize:10, color:'#999', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:2 }}>Total Net Worth</div>
              <div className="serif" style={{ fontSize:22, fontWeight:700 }}>{fmtTWD(c.netWorth)}</div>
              <div style={{ display:'flex', alignItems:'center', gap:8, justifyContent:'flex-end', marginTop:3 }}>
                <span style={{ fontSize:10, color:'#999' }}>USD/TWD {c.fx.toFixed(2)} · {lastUpdated?.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})}</span>
                <button onClick={refetch} style={{ background:'none', border:'1.5px solid #e6e2dc', borderRadius:4, padding:'4px 10px', fontSize:12, fontWeight:600, color:'#555', cursor:'pointer' }}>↻</button>
              </div>
            </div>
          </div>
          <div style={{ display:'flex', overflowX:'auto', marginTop:2, WebkitOverflowScrolling:'touch' }}>
            {TABS.map(([k,v]) => <button key={k} className={`tab-btn ${tab===k?'active':''}`} onClick={()=>setTab(k)}>{v}</button>)}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:960, margin:'0 auto', padding:'16px 16px 80px' }}>

        {/* 警示：直接顯示，不收起 */}
        {c.warns.length > 0 && (
          <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:14 }}>
            {c.warns.map((w,i) => <div key={i} className="wc">⚠ {w}</div>)}
          </div>
        )}

        {/* OVERVIEW */}
        {tab === 'overview' && (
          <div className="fu" style={{ display:'grid', gap:12 }}>

            {/* 經濟象限 + 匯率 — 完整顯示 */}
            <div className="card" style={{ padding:'12px 18px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:10 }}>
                {/* 左：象限指標 */}
                <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                  <div style={{ fontSize:11, color:'#999', fontWeight:700, letterSpacing:'.08em', textTransform:'uppercase' }}>經濟象限</div>
                  {/* 成長方向 */}
                  {c.growthS && (
                    <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                      <span style={{ fontSize:11, color:'#777' }}>成長</span>
                      <span style={{ fontSize:14, fontWeight:700, color: c.growthS === '↑' ? '#16a34a' : '#dc2626' }}>{c.growthS}</span>
                    </div>
                  )}
                  {/* 通膨方向 */}
                  {c.inflS && (
                    <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                      <span style={{ fontSize:11, color:'#777' }}>通膨</span>
                      <span style={{ fontSize:14, fontWeight:700, color: c.inflS === '↑' ? '#dc2626' : '#16a34a' }}>{c.inflS}</span>
                    </div>
                  )}
                  {/* 象限 */}
                  <div style={{ fontSize:14, fontWeight:700 }}>{c.quadrant}</div>
                  {/* 確認狀態 */}
                  {c.quadConfirm && (
                    <span style={{
                      fontSize:11, padding:'2px 8px', borderRadius:3, fontWeight:600,
                      background: c.quadConfirm.includes('確認') ? '#f0fdf4' : '#fefce8',
                      color:      c.quadConfirm.includes('確認') ? '#16a34a' : '#a16207',
                      border:     `1px solid ${c.quadConfirm.includes('確認') ? '#bbf7d0' : '#fde68a'}`,
                    }}>{c.quadConfirm}</span>
                  )}
                </div>
                {/* 右：匯率 + Stress */}
                <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                  {c.fxTrend && (
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:10, color:'#999', marginBottom:2 }}>匯率趨勢（90天）</div>
                      <div style={{ fontSize:13, fontWeight:600, color: c.fxTrend.includes('貶') ? '#dc2626' : '#2563eb' }}>{c.fxTrend}</div>
                    </div>
                  )}
                  <div style={{ fontSize:13 }}>{c.stressStatus}</div>
                </div>
              </div>
            </div>

            {/* KPIs — 桌面5格 */}
            <div className="g5" style={{ display:'grid', gap:10 }}>
              {[
                { lbl:'可投資基礎', val:fmtTWD(c.base),  sub:'Cash + Investment' },
                { lbl:'未實現損益', val:`${c.totPnL>=0?'+':''}${fmtTWD(c.totPnL)}`, sub:'所有持倉', green:c.totPnL>0, red:c.totPnL<0 },
                { lbl:'月被動收益', val:fmtTWD(c.monthly), sub:'利息＋股息（估）' },
                { lbl:'目標達成率', val:fmtPct(c.goalPct), sub:`目標 ${fmtTWD(c.targetNW)}` },
                { lbl:'年化收益率', val:fmtPct(c.annYield), sub:'被動收益 / 可投資基礎' },
              ].map((k,i) => (
                <div key={i} className="card" style={{ padding:'14px 16px' }}>
                  <div className="lbl" style={{ marginBottom:6 }}>{k.lbl}</div>
                  <div className="serif" style={{ fontSize:16, fontWeight:700, color:(k as {green?:boolean;red?:boolean}).green?'#16a34a':(k as {green?:boolean;red?:boolean}).red?'#dc2626':'#1a1a1a', lineHeight:1.3 }}>{k.val}</div>
                  <div style={{ fontSize:11, color:'#888', marginTop:3 }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* Goal */}
            <div className="card" style={{ padding:'14px 18px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:9, alignItems:'flex-end' }}>
                <div>
                  <div className="lbl" style={{ marginBottom:2 }}>目標淨資產進度</div>
                  <div style={{ fontSize:13, color:'#555' }}>{fmtTWD(c.netWorth)} <span style={{ color:'#bbb' }}>/ {fmtTWD(c.targetNW)}</span></div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div className="serif" style={{ fontSize:20, fontWeight:700 }}>{fmtPct(c.goalPct)}</div>
                  <div style={{ fontSize:11, color:'#999' }}>{c.estMonths ? `預估 ${c.estMonths} 個月達成` : '計算中'}</div>
                </div>
              </div>
              <div className="bar" style={{ height:7 }}>
                <div className="bf" style={{ width:mounted?`${Math.min(c.goalPct,1)*100}%`:'0%', background:'#1a1a1a', opacity:.8 }} />
              </div>
            </div>

            <div className="g2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {/* All Weather */}
              <div className="card">
                <div className="lbl">All Weather 配置</div>
                {c.awRows.map((r,i) => (
                  <div key={i} style={{ marginBottom:i<2?18:0 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                        <div style={{ width:7, height:7, borderRadius:'50%', background:CAT_COLOR[r.cat] }} />
                        <span style={{ fontSize:14, fontWeight:600 }}>{r.cat}</span>
                        <span className={`bdg ${r.gap>0.01?'buy':r.gap<-0.01?'over':'ok'}`}>{r.gap>0.01?'BUY':r.gap<-0.01?'OVER':'OK'}</span>
                      </div>
                      <span style={{ fontSize:12, color:'#555' }}>{fmtPct(r.cur)} <span style={{ color:'#bbb' }}>/ {fmtPct(r.tgt)}</span></span>
                    </div>
                    <div className="bar"><div className="bf" style={{ width:mounted?`${Math.min(r.cur/r.tgt,1)*100}%`:'0%', background:CAT_COLOR[r.cat], opacity:.7 }} /></div>
                    <div style={{ fontSize:11, color:'#777', marginTop:4 }}>{r.gap>0?`缺口 ${fmtTWD(r.gapAmt)}`:`超配 ${fmtPct(Math.abs(r.gap))}`}</div>
                  </div>
                ))}
              </div>

              {/* Right */}
              <div style={{ display:'grid', gap:12 }}>
                <div className="card">
                  <div className="lbl">台美資產分布</div>
                  {[
                    { lbl:'台幣資產', val:c.twdTotal, pct:c.twdPct, color:'#2563eb' },
                    { lbl:'美元資產', val:c.usdTotal, pct:c.usdPct, color:'#d97706' },
                  ].map((r,i) => (
                    <div key={i} style={{ marginBottom:i===0?12:0 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                        <span style={{ fontSize:13, fontWeight:500 }}>{r.lbl}</span>
                        <span style={{ fontSize:12, color:'#555' }}>{fmtPct(r.pct)}</span>
                      </div>
                      <div className="bar"><div className="bf" style={{ width:mounted?`${r.pct*100}%`:'0%', background:r.color, opacity:.65 }} /></div>
                      <div style={{ fontSize:11, color:'#777', marginTop:3 }}>{fmtTWD(r.val)}</div>
                    </div>
                  ))}
                </div>
                <div className="card">
                  <div className="lbl">被動收益（估算）</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
                    {[{lbl:'利息/yr',v:c.annInt},{lbl:'股息/yr',v:c.annDiv}].map((r,i) => (
                      <div key={i}>
                        <div style={{ fontSize:11, color:'#777', marginBottom:3 }}>{r.lbl}</div>
                        <div className="serif" style={{ fontSize:14, fontWeight:700 }}>{fmtTWD(r.v)}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize:11, color:'#777', marginBottom:3 }}>月被動收益</div>
                  <div className="serif" style={{ fontSize:17, fontWeight:700 }}>{fmtTWD(c.monthly)}</div>
                </div>
              </div>
            </div>

            {/* Monthly */}
            {(c.monthSalary>0||c.monthBonus>0||c.monthDividend>0||c.monthOther>0) && (
              <div className="card">
                <div className="lbl">本月資金流入</div>
                <div className="g4" style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
                  {[{lbl:'薪資',v:c.monthSalary},{lbl:'獎金',v:c.monthBonus},{lbl:'股息實收',v:c.monthDividend},{lbl:'其他',v:c.monthOther}].map((r,i) => (
                    <div key={i}>
                      <div style={{ fontSize:11, color:'#777', marginBottom:4 }}>{r.lbl}</div>
                      <div className="serif" style={{ fontSize:14, fontWeight:700, color:r.v>0?'#1a1a1a':'#ccc' }}>{r.v>0?fmtTWD(r.v):'—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize:10, color:'#ccc', textAlign:'right' }}>股價來源：Google Sheets GOOGLEFINANCE · 約 15-20 分鐘更新</div>
          </div>
        )}

        {/* POSITIONS */}
        {tab === 'positions' && (
          <div className="fu card">
            <div className="lbl">持倉明細</div>
            <div className="ptable" style={{ display:'grid', gridTemplateColumns:'80px 1fr 96px 88px 56px', gap:8, paddingBottom:9, borderBottom:'2px solid #f0ede8' }}>
              {['Ticker','名稱 / 詳情','市值','損益','報酬%'].map(h => (
                <div key={h} style={{ fontSize:10, fontWeight:700, letterSpacing:'.07em', textTransform:'uppercase', color:'#888' }}>{h}</div>
              ))}
            </div>
            {c.positions.map((p,i) => (
              <div key={i} className="ptable" style={{ display:'grid', gridTemplateColumns:'80px 1fr 96px 88px 56px', gap:8, alignItems:'center', padding:'11px 0', borderBottom:'1px solid #f0ede8' }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:700 }}>{p.ticker}</div>
                  <div style={{ fontSize:10, color:CAT_COLOR[p.category], marginTop:2, fontWeight:700 }}>{p.category}</div>
                </div>
                <div>
                  <div style={{ fontSize:13, color:'#222' }}>{p.name}</div>
                  <div style={{ fontSize:11, color:'#888', marginTop:2 }}>
                    {p.sh.toLocaleString()} 股 · 均 {fmtNum(p.avgCost)} {p.currency}
                    {p.cp>0 && <span style={{ marginLeft:5 }}>· 現 {fmtNum(p.cp)}</span>}
                    <span style={{ marginLeft:5, color:'#bbb' }}>· {fmtPct(p.portPct)}</span>
                  </div>
                </div>
                <div className="serif" style={{ fontSize:13, fontWeight:700 }}>{fmtTWD(p.mvTWD)}</div>
                <div className="serif" style={{ fontSize:13, fontWeight:700, color:p.pnlTWD>=0?'#16a34a':'#dc2626' }}>
                  {p.pnlTWD>=0?'+':''}{fmtTWD(p.pnlTWD)}
                </div>
                <div style={{ fontSize:13, color:p.ret>=0?'#16a34a':'#dc2626', fontWeight:700 }}>
                  {p.ret>=0?'+':''}{fmtPct(p.ret)}
                </div>
              </div>
            ))}
            <div style={{ display:'flex', justifyContent:'space-between', paddingTop:12, borderTop:'2px solid #f0ede8', marginTop:2 }}>
              <span style={{ fontSize:13, color:'#555', fontWeight:600 }}>總投資市值</span>
              <span className="serif" style={{ fontSize:16, fontWeight:700 }}>{fmtTWD(c.totInv)}</span>
            </div>
          </div>
        )}

        {/* REBALANCE */}
        {tab === 'rebalance' && (
          <div className="fu" style={{ display:'grid', gap:12 }}>

            {/* Step 1 DCA */}
            <div className="card">
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
                <span className="step-tag" style={{ background:'#1a1a1a', color:'#fff' }}>Step 1</span>
                <div className="lbl" style={{ marginBottom:0 }}>月定投計劃（{fmtTWD(c.fixedDCA)}）</div>
                <span style={{ fontSize:11, color:'#999' }}>固定執行，不受象限影響</span>
              </div>
              {c.dcaPlan.map((d,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 0', borderBottom:i<c.dcaPlan.length-1?'1px solid #f0ede8':'none' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <span className="bdg buy">DCA</span>
                    <div>
                      <div style={{ fontSize:15, fontWeight:700 }}>{d.ticker}</div>
                      <div style={{ fontSize:12, color:'#666', marginTop:2 }}>
                        {d.name} · <strong style={{ color:'#1a1a1a' }}>{d.shares} 股</strong> · 預算 {fmtTWD(d.budget)}
                        {d.cp>0 && <span style={{ color:'#999', marginLeft:5 }}>· 現價 {fmtNum(d.cp,0)}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div className="serif" style={{ fontSize:14, fontWeight:700 }}>{fmtTWD(d.amt)}</div>
                    <div style={{ fontSize:11, color:'#bbb', marginTop:2 }}>殘差 {fmtTWD(d.residual)}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Step 2 AW Gap */}
            <div className="card">
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                <span className="step-tag" style={{ background:'#374151', color:'#fff' }}>Step 2</span>
                <div className="lbl" style={{ marginBottom:0 }}>All Weather 缺口</div>
                <span style={{ fontSize:11, color:'#999' }}>彈性執行，依缺口補足</span>
              </div>
              <div style={{ fontSize:12, color:'#777', marginBottom:14 }}>可動用現金 {fmtTWD(c.avail)} · 象限：{c.quadrant}</div>
              {c.awRows.map((r,i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 0', borderBottom:i<c.awRows.length-1?'1px solid #f0ede8':'none' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ width:8, height:8, borderRadius:'50%', background:CAT_COLOR[r.cat] }} />
                    <div>
                      <div style={{ fontSize:14, fontWeight:600 }}>{r.cat}</div>
                      <div style={{ fontSize:11, color:'#777', marginTop:2 }}>現況 {fmtPct(r.cur)} → 目標 {fmtPct(r.tgt)}</div>
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <span className={`bdg ${r.gap>0.01?'buy':r.gap<-0.01?'over':'ok'}`}>{r.gap>0.01?'BUY':r.gap<-0.01?'OVER':'OK'}</span>
                    <div className="serif" style={{ fontSize:14, fontWeight:700, marginTop:4, color:r.gap>0?'#16a34a':'#dc2626' }}>
                      {r.gap>0?'+':''}{fmtTWD(r.gapAmt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Deployment — 修正：平均分配，不按 portPct */}
            <div className="card">
              <div className="lbl">戰略部署建議（{fmtTWD(c.deployAmt)}）</div>
              {(() => {
                const suggestions = c.awRows
                  .filter(r => r.gap > 0.01)
                  .flatMap(r => {
                    const catPos = c.positions.filter(p => p.category === r.cat);
                    if (catPos.length === 0) return [];
                    const budgetPerPos = Math.min(c.deployAmt, r.gapAmt) / catPos.length;
                    return catPos.map(p => {
                      const pTWD = p.currency === 'USD' ? p.cp * c.fx : p.cp;
                      const sh = pTWD > 0 ? Math.floor(budgetPerPos / pTWD) : 0;
                      return { p, sh, pTWD, amt: sh * pTWD };
                    }).filter(x => x.sh > 0);
                  });
                if (suggestions.length === 0)
                  return <div style={{ fontSize:13, color:'#bbb', padding:'8px 0' }}>目前無明顯缺口需要補足</div>;
                return suggestions.map(({ p, sh, pTWD, amt }, i) => (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 0', borderBottom:'1px solid #f0ede8' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span className="bdg buy">BUY</span>
                      <div>
                        <div style={{ fontSize:14, fontWeight:700 }}>{p.ticker}</div>
                        <div style={{ fontSize:12, color:'#666', marginTop:2 }}>
                          {p.name} · <strong style={{ color:'#1a1a1a' }}>{sh} 股</strong> · {p.currency==='USD'?`$${fmtNum(p.cp)} USD`:`NT$ ${fmtNum(p.cp,0)}`}
                        </div>
                      </div>
                    </div>
                    <div className="serif" style={{ fontSize:14, fontWeight:700, color:'#16a34a' }}>{fmtTWD(amt)}</div>
                  </div>
                ));
              })()}
            </div>
          </div>
        )}

        {/* SIMULATE */}
        {tab === 'simulate' && (
          <div className="fu" style={{ display:'grid', gap:12 }}>
            <div className="card">
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
                <div className="lbl" style={{ marginBottom:0 }}>多標的加倉模擬</div>
                <button className="bp" onClick={() => setSimRows(r => [...r, {
                  mode:'list', ticker:c.tickers[0]?String(c.tickers[0].ticker):'',
                  shares:10, customTicker:'', customPrice:0, customCurrency:'USD'
                }])}>＋ 新增</button>
              </div>

              <div style={{ background:'#faf9f7', border:'1px solid #e6e2dc', borderRadius:4, padding:'10px 14px', marginBottom:16 }}>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.09em', textTransform:'uppercase', color:'#888', marginBottom:6 }}>All Weather 缺口參考</div>
                <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                  {c.awRows.filter(r => r.gap>0.01).map((r,i) => (
                    <div key={i} style={{ fontSize:12 }}>
                      <span style={{ color:CAT_COLOR[r.cat], fontWeight:700 }}>{r.cat}</span>
                      <span style={{ color:'#777', marginLeft:4 }}>缺 {fmtTWD(r.gapAmt)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {simRows.map((row,i) => (
                <div key={i} style={{ border:'1px solid #e6e2dc', borderRadius:4, padding:'12px 14px', marginBottom:10 }}>
                  <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                    {(['list','custom'] as const).map(m => (
                      <button key={m} onClick={() => setSimRows(r => r.map((x,j) => j===i?{...x,mode:m}:x))}
                        style={{ fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:3, cursor:'pointer', border:'1.5px solid', borderColor:row.mode===m?'#1a1a1a':'#e6e2dc', background:row.mode===m?'#1a1a1a':'transparent', color:row.mode===m?'#fff':'#888' }}>
                        {m==='list'?'從清單選':'手動輸入'}
                      </button>
                    ))}
                  </div>
                  {row.mode === 'list' ? (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 110px 36px', gap:8, alignItems:'center' }}>
                      <select className="inp" value={row.ticker} onChange={e => setSimRows(r => r.map((x,j) => j===i?{...x,ticker:e.target.value}:x))}>
                        {c.tickers.map(t => <option key={t.ticker} value={String(t.ticker)}>{t.ticker} · {t.name}</option>)}
                      </select>
                      <input type="number" className="inp" value={row.shares} min={0} placeholder="股數" onChange={e => setSimRows(r => r.map((x,j) => j===i?{...x,shares:Number(e.target.value)}:x))} />
                      <button className="bd-r" onClick={() => setSimRows(r => r.filter((_,j) => j!==i))}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 75px 90px 110px 36px', gap:8, alignItems:'center' }}>
                      <input className="inp" placeholder="Ticker（如 TLT）" value={row.customTicker} onChange={e => setSimRows(r => r.map((x,j) => j===i?{...x,customTicker:e.target.value.toUpperCase()}:x))} />
                      <select className="inp" value={row.customCurrency} onChange={e => setSimRows(r => r.map((x,j) => j===i?{...x,customCurrency:e.target.value}:x))}>
                        <option value="TWD">TWD</option>
                        <option value="USD">USD</option>
                      </select>
                      <input type="number" className="inp" placeholder="模擬價格" value={row.customPrice||''} min={0} onChange={e => setSimRows(r => r.map((x,j) => j===i?{...x,customPrice:Number(e.target.value)}:x))} />
                      <input type="number" className="inp" placeholder="股數" value={row.shares} min={0} onChange={e => setSimRows(r => r.map((x,j) => j===i?{...x,shares:Number(e.target.value)}:x))} />
                      <button className="bd-r" onClick={() => setSimRows(r => r.filter((_,j) => j!==i))}>✕</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {simResults.length > 0 && (
              <div className="card">
                <div className="lbl">模擬結果</div>
                {simResults.map((r,i) => (
                  <div key={i} style={{ background:'#faf9f7', border:'1px solid #e6e2dc', borderRadius:4, padding:'14px', marginBottom:10 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12 }}>
                      <div>
                        <span style={{ fontSize:14, fontWeight:700 }}>{r.ticker}</span>
                        <span style={{ fontSize:12, color:'#777', marginLeft:8 }}>{r.name} · 買入 {r.qty} 股</span>
                        {r.origSh===0 && <span style={{ fontSize:10, fontWeight:700, marginLeft:6, padding:'2px 6px', background:'#f0f9ff', color:'#0284c7', borderRadius:2, border:'1px solid #bae6fd' }}>NEW</span>}
                      </div>
                      <div className="serif" style={{ fontSize:14, fontWeight:700, color:'#16a34a' }}>{fmtTWD(r.buyAmt)}</div>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
                      {[
                        { lbl:'新均成本', b:r.origSh>0?`${fmtNum(r.origAvg)} ${r.currency}`:'—', a:`${fmtNum(r.nAvg)} ${r.currency}` },
                        { lbl:'持股數',   b:`${r.origSh} 股`, a:`${r.nSh} 股` },
                        { lbl:'未實現損益', b:r.origSh>0?`${r.origPnL>=0?'+':''}${fmtTWD(r.origPnL)}`:'—', a:`${r.nPnL>=0?'+':''}${fmtTWD(r.nPnL)}` },
                        { lbl:'報酬率',   b:r.origSh>0?`${r.origRet>=0?'+':''}${fmtPct(r.origRet)}`:'—', a:`${r.nRet>=0?'+':''}${fmtPct(r.nRet)}` },
                      ].map((cc,j) => (
                        <div key={j}>
                          <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.07em', textTransform:'uppercase', color:'#888', marginBottom:4 }}>{cc.lbl}</div>
                          <div style={{ fontSize:11, color:'#bbb', textDecoration:'line-through', marginBottom:2 }}>{cc.b}</div>
                          <div style={{ fontSize:13, fontWeight:700 }}>{cc.a}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="hr" />
                <div className="lbl">執行後 All Weather 配置</div>
                {Object.entries(c.awTargets).map(([cat,tgt],i) => {
                  const bef = c.base>0?c.awCur[cat]/c.base:0;
                  const aft = simNewBase>0?simNewAW[cat]/simNewBase:0;
                  return (
                    <div key={i} style={{ marginBottom:i<2?14:0 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                          <div style={{ width:7, height:7, borderRadius:'50%', background:CAT_COLOR[cat] }} />
                          <span style={{ fontSize:13, fontWeight:600 }}>{cat}</span>
                        </div>
                        <span style={{ fontSize:12 }}>
                          <span style={{ color:'#777' }}>{fmtPct(bef)}</span>
                          <span style={{ color:'#ccc', margin:'0 5px' }}>→</span>
                          <span style={{ fontWeight:700, color:CAT_COLOR[cat] }}>{fmtPct(aft)}</span>
                          <span style={{ color:'#bbb' }}> / {fmtPct(tgt)}</span>
                        </span>
                      </div>
                      <div className="bar"><div className="bf" style={{ width:`${Math.min(aft/tgt,1)*100}%`, background:CAT_COLOR[cat], opacity:.65 }} /></div>
                    </div>
                  );
                })}
                <div className="hr" />
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <div>
                    <div style={{ fontSize:11, color:'#777', marginBottom:3 }}>模擬總投入</div>
                    <div className="serif" style={{ fontSize:18, fontWeight:700 }}>{fmtTWD(simTotal)}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:11, color:'#777', marginBottom:3 }}>執行後可動用現金</div>
                    <div className="serif" style={{ fontSize:18, fontWeight:700, color:c.avail-simTotal<0?'#dc2626':'#1a1a1a' }}>{fmtTWD(c.avail-simTotal)}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* REALIZED */}
        {tab === 'realized' && (
          <div className="fu card">
            <div className="lbl">已實現績效</div>
            {c.realizedRows.length === 0
              ? <div style={{ fontSize:14, color:'#999', padding:'16px 0' }}>尚無已出場紀錄</div>
              : c.realizedRows.map((r,i) => (
                <div key={i} style={{ padding:'16px 0', borderBottom:i<c.realizedRows.length-1?'1px solid #f0ede8':'none' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12 }}>
                    <div>
                      <div style={{ fontSize:15, fontWeight:700 }}>{String(r.ticker)} · {String(r.instrument)}</div>
                      <div style={{ fontSize:11, color:'#999', marginTop:3 }}>持有 {r.holdingDays} 天</div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div className="serif" style={{ fontSize:16, fontWeight:700, color:r.pnlTWD>=0?'#16a34a':'#dc2626' }}>
                        {r.pnlTWD>=0?'+':''}{fmtTWD(r.pnlTWD)}
                      </div>
                      <div style={{ fontSize:12, color:'#888', marginTop:2 }}>報酬率 {fmtPct(r.returnPct)}</div>
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
                    {[
                      {lbl:'買入成本', v:fmtTWD(r.buyCost)},
                      {lbl:'賣出金額', v:fmtTWD(r.sellValue)},
                      {lbl:'年化報酬', v:fmtPct(r.annReturn)},
                      {lbl:'年化 Alpha', v:fmtPct(r.annAlpha)},
                    ].map((cc,j) => (
                      <div key={j}>
                        <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.07em', textTransform:'uppercase', color:'#888', marginBottom:4 }}>{cc.lbl}</div>
                        <div style={{ fontSize:13, fontWeight:600 }}>{cc.v}</div>
                      </div>
                    ))}
                  </div>
                  {r.notes && <div style={{ fontSize:12, color:'#888', marginTop:10, fontStyle:'italic' }}>「{r.notes}」</div>}
                </div>
              ))
            }
          </div>
        )}

      </div>
    </div>
  );
}