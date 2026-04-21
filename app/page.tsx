'use client';
import { useState, useEffect } from 'react';

// ── Formatters ──
const fmtTWD = (n: number) => `NT$ ${Math.round(n).toLocaleString('zh-TW')}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtNum = (n: number, d = 2) => Number(n).toFixed(d);
const toF = (v: unknown): number => parseFloat(String(v ?? '0').replace(/,/g, '')) || 0;

const CAT_COLOR: Record<string, string> = {
  Growth: '#16a34a', Inflation: '#d97706', Deflation: '#2563eb'
};

// ── Types ──
interface Ticker { ticker: string; name: string; currency: string; category: string; yield: number; }
interface Bank { name: string; rate: number; }
interface Position extends Ticker { sh: number; costTWD: number; cp: number; mvTWD: number; pnlTWD: number; ret: number; avgCost: number; portPct: number; }
interface AWRow { cat: string; tgt: number; cur: number; gap: number; gapAmt: number; }

// ── Data hook ──
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
      setData(json);
      setLastUpdated(new Date());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '未知錯誤');
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchData(); }, []);
  return { data, loading, error, lastUpdated, refetch: fetchData };
}

// ── Compute ──
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
    Growth: toF(cfg['Growth目標佔比']) || 0.6,
    Inflation: toF(cfg['Inflation目標佔比']) || 0.2,
    Deflation: toF(cfg['Deflation目標佔比']) || 0.2,
  };
  const deployAmt = toF(cfg['月戰略部署金額']) || 100000;
  const targetNW = toF(cfg['目標淨資產']) || 5000000;
  const fixedDCA = toF(cfg['月固定投入']) || 10000;
  const dca6208Pct = toF(cfg['006208定投佔比']) || 0.7;
  const dca878Pct = toF(cfg['00878定投佔比']) || 0.3;

  // Positions
  const positions: Position[] = tickers.map(t => {
    const tid = String(t.ticker);
    const buys = trades.filter(r => String(r[1]) === tid && r[3] === 'Buy');
    const sells = trades.filter(r => String(r[1]) === tid && r[3] === 'Sell');
    const sh = buys.reduce((s, r) => s + toF(r[6]), 0) - sells.reduce((s, r) => s + toF(r[6]), 0);
    const costTWD = buys.reduce((s, r) => s + toF(r[12]), 0);
    if (sh <= 0) return null;
    const cpKey = tid.length <= 4 && !isNaN(Number(tid)) ? `00${tid}現價` : `${tid}現價`;
    const cp = toF(cfg[`${tid}現價`]) || toF(cfg[cpKey]) || 0;
    const mvTWD = cp > 0 ? (t.currency === 'USD' ? cp * sh * fx : cp * sh) : costTWD;
    const pnlTWD = cp > 0 ? mvTWD - costTWD : 0;
    const ret = costTWD > 0 && cp > 0 ? pnlTWD / costTWD : 0;
    const avgCost = t.currency === 'USD' ? (costTWD / sh) / fx : costTWD / sh;
    return { ...t, sh, costTWD, cp, mvTWD, pnlTWD, ret, avgCost, portPct: 0 };
  }).filter(Boolean) as Position[];

  const totInv = positions.reduce((s, p) => s + p.mvTWD, 0);
  positions.forEach(p => { p.portPct = totInv > 0 ? p.mvTWD / totInv : 0; });

  // Cash
  const bankRows = caps.filter(r => toF(r[9]) > 0);
  const latestBank = bankRows.length > 0 ? toF(bankRows[bankRows.length - 1][9]) : 0;
  const avail = Math.max(0, latestBank - unavail);
  const base = avail + totInv;
  const netWorth = latestBank + totInv;

  // TWD/USD split
  const twdStocks = positions.filter(p => p.currency === 'TWD').reduce((s, p) => s + p.mvTWD, 0);
  const usdStocks = positions.filter(p => p.currency === 'USD').reduce((s, p) => s + p.mvTWD, 0);
  const twdTotal = latestBank + twdStocks;
  const usdTotal = usdStocks;
  const twdPct = netWorth > 0 ? twdTotal / netWorth : 0;
  const usdPct = netWorth > 0 ? usdTotal / netWorth : 0;

  // AW
  const awCur: Record<string, number> = { Growth: 0, Inflation: 0, Deflation: avail };
  positions.forEach(p => { awCur[p.category] = (awCur[p.category] || 0) + p.mvTWD; });
  const awRows: AWRow[] = Object.entries(awTargets).map(([cat, tgt]) => ({
    cat, tgt,
    cur: base > 0 ? awCur[cat] / base : 0,
    gap: tgt - (base > 0 ? awCur[cat] / base : 0),
    gapAmt: (tgt - (base > 0 ? awCur[cat] / base : 0)) * base,
  }));

  // Passive income - precise per bank
  const annInt = banks.reduce((s, b) => s + latestBank * b.rate / banks.length, 0);
  const annDiv = positions.reduce((s, p) => s + p.mvTWD * (p.yield || 0), 0);
  const monthly = (annInt + annDiv) / 12;
  const annYield = base > 0 ? (annInt + annDiv) / base : 0;

  // Capital flows - last month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthCaps = caps.filter(r => {
    const d = new Date(String(r[0]));
    return d >= monthStart;
  });
  const monthSalary = monthCaps.filter(r => r[1] === 'Salary').reduce((s, r) => s + toF(r[2]), 0);
  const monthBonus = monthCaps.filter(r => r[1] === 'Bonus').reduce((s, r) => s + toF(r[2]), 0);
  const monthDividend = monthCaps.filter(r => String(r[1]).startsWith('Dividend')).reduce((s, r) => s + toF(r[2]), 0);
  const monthOther = monthCaps.filter(r => r[1] === 'Non-leaving pay').reduce((s, r) => s + toF(r[2]), 0);

  // Goal
  const goalPct = targetNW > 0 ? netWorth / targetNW : 0;
  const recent6 = bankRows.slice(-7);
  let monthlyGrowth = 0;
  if (recent6.length >= 2) {
    const diffs = [];
    for (let i = 1; i < recent6.length; i++) {
      diffs.push(toF(recent6[i][9]) - toF(recent6[i - 1][9]));
    }
    monthlyGrowth = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  }
  const estMonths = monthlyGrowth > 0 ? Math.ceil((targetNW - netWorth) / monthlyGrowth) : null;

  // DCA plan
  const dcaPlan = [
    { ticker: '6208', name: '富邦台50', budget: fixedDCA * dca6208Pct, cp: toF(cfg['6208現價']) },
    { ticker: '878', name: '國泰ESG', budget: fixedDCA * dca878Pct, cp: toF(cfg['00878現價']) },
  ].map(d => ({ ...d, shares: d.cp > 0 ? Math.floor(d.budget / d.cp) : 0, amt: 0 }))
    .map(d => ({ ...d, amt: d.shares * d.cp, residual: d.budget - d.shares * d.cp }));

  // Warnings
  const warns: string[] = [];
  positions.forEach(p => {
    const isETF = !['2059', '6584'].includes(String(p.ticker));
    const sl = isETF ? toF(cfg['ETF停損線']) || -0.25 : toF(cfg['個股停損線']) || -0.15;
    if (!isETF && p.ret >= (toF(cfg['個股報酬達標線']) || 0.8)) warns.push(`${p.ticker} 報酬率達 ${fmtPct(p.ret)}，建議評估出場`);
    if (p.ret <= sl) warns.push(`${p.ticker} 跌破停損線（${fmtPct(p.ret)}），建議檢視`);
    if (p.portPct >= (toF(cfg['單一標的上限']) || 0.35)) warns.push(`${p.ticker} 佔組合 ${fmtPct(p.portPct)}，超過上限`);
  });
  awRows.forEach(r => { if (Math.abs(r.gap) >= (toF(cfg['失衡警戒幅度']) || 0.15)) warns.push(`${r.cat} 偏離目標 ${fmtPct(Math.abs(r.gap))}，建議再平衡`); });
  if (latestBank > 0 && avail <= (toF(cfg['現金水位警戒線']) || 500000)) warns.push(`可動用現金 ${fmtTWD(avail)}，低於警戒線`);

  const quadrant = String(cfg['當前象限'] || '—');
  const stressStatus = String(cfg['Stress Regime狀態'] || '—');
  const totPnL = positions.reduce((s, p) => s + p.pnlTWD, 0);

  const realizedRows = realized.map(r => ({
    ticker: r[0], instrument: r[1], holdingDays: toF(r[7]),
    buyCost: toF(r[8]), sellValue: toF(r[9]), pnlTWD: toF(r[10]),
    returnPct: toF(r[11]), annReturn: toF(r[12]),
    benchmark: toF(r[13]), annAlpha: toF(r[15]), notes: String(r[16] || ''),
  }));

  return {
    cfg, fx, positions, totInv, latestBank, avail, base, netWorth,
    twdTotal, usdTotal, twdPct, usdPct,
    awRows, awCur, awTargets, totPnL, monthly, annInt, annDiv, annYield,
    goalPct, estMonths, targetNW, deployAmt, fixedDCA,
    warns, quadrant, stressStatus, realizedRows, dcaPlan,
    monthSalary, monthBonus, monthDividend, monthOther,
  };
}

// ── Main Component ──
export default function Dashboard() {
  const { data, loading, error, lastUpdated, refetch } = usePortfolioData();
  const [tab, setTab] = useState('overview');
  const [mounted, setMounted] = useState(false);
  const [simRows, setSimRows] = useState([{ ticker: 'QQQM', shares: 5 }, { ticker: 'VOO', shares: 2 }]);

  useEffect(() => { setTimeout(() => setMounted(true), 150); }, []);
  const c = compute(data);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#f7f6f3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, fontFamily: 'system-ui' }}>
      <div style={{ width: 32, height: 32, border: '2.5px solid #e6e2dc', borderTop: '2.5px solid #1a1a1a', borderRadius: '50%', animation: 'spin .8s linear infinite' }} />
      <div style={{ fontSize: 15, color: '#555' }}>載入數據中…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (error) return (
    <div style={{ minHeight: '100vh', background: '#f7f6f3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, fontFamily: 'system-ui', padding: 32 }}>
      <div style={{ color: '#dc2626', fontSize: 15 }}>⚠ 無法載入：{error}</div>
      <button onClick={refetch} style={{ padding: '10px 24px', background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 15 }}>重試</button>
    </div>
  );

  if (!c) return null;

  const TABS = [['overview', '總覽'], ['positions', '持倉'], ['rebalance', '再平衡'], ['simulate', '模擬'], ['realized', '績效']];

  // Simulation
  const simResults = simRows.map(row => {
    const p = c.positions.find(x => String(x.ticker) === row.ticker);
    if (!p || !p.cp) return null;
    const qty = Number(row.shares) || 0;
    const pTWD = p.currency === 'USD' ? p.cp * c.fx : p.cp;
    const buyAmt = pTWD * qty;
    const nCost = p.costTWD + buyAmt;
    const nSh = p.sh + qty;
    const nAvg = p.currency === 'USD' ? (nCost / nSh) / c.fx : nCost / nSh;
    const nMV = pTWD * nSh;
    const nPnL = nMV - nCost;
    const nRet = nCost > 0 ? nPnL / nCost : 0;
    return { ...p, qty, buyAmt, nAvg, nSh, nMV, nPnL, nRet };
  }).filter(Boolean) as (Position & { qty: number; buyAmt: number; nAvg: number; nSh: number; nMV: number; nPnL: number; nRet: number; })[];

  const simTotal = simResults.reduce((s, r) => s + r.buyAmt, 0);
  const simNewBase = c.base + simTotal;
  const simNewAW: Record<string, number> = { ...c.awCur };
  simResults.forEach(r => { simNewAW[r.category] = (simNewAW[r.category] || 0) + r.buyAmt; });

  return (
    <div style={{ minHeight: '100vh', background: '#f7f6f3', fontFamily: "'DM Sans', system-ui", color: '#1a1a1a' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        html{-webkit-text-size-adjust:100%}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
        .serif{font-family:'Libre Baskerville',Georgia,serif}
        .card{background:#fff;border:1px solid #e6e2dc;border-radius:6px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.05)}
        .lbl{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#555;margin-bottom:10px}
        .tab-btn{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:14px 16px;border:none;background:none;cursor:pointer;color:#666;border-bottom:2.5px solid transparent;transition:all .2s;white-space:nowrap}
        .tab-btn.active{color:#1a1a1a;border-bottom-color:#1a1a1a}
        .tab-btn:hover:not(.active){color:#333}
        .bdg{font-size:11px;font-weight:700;padding:4px 10px;border-radius:3px}
        .buy{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
        .over{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
        .ok{background:#f0f9ff;color:#0284c7;border:1px solid #bae6fd}
        .bar{background:#e8e4de;height:5px;border-radius:3px;overflow:hidden}
        .bf{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.4,0,.2,1)}
        .inp{font-family:'DM Sans',system-ui;font-size:15px;background:#faf9f7;border:1.5px solid #e6e2dc;color:#1a1a1a;padding:10px 14px;border-radius:4px;width:100%;outline:none}
        .inp:focus{border-color:#1a1a1a;background:#fff}
        .bp{font-family:'DM Sans',system-ui;font-size:14px;font-weight:600;padding:10px 18px;border-radius:4px;cursor:pointer;background:#1a1a1a;color:#fff;border:none}
        .bd{font-family:'DM Sans',system-ui;font-size:13px;padding:8px 12px;border-radius:4px;cursor:pointer;background:none;border:1.5px solid #fecaca;color:#dc2626}
        .hr{border:none;border-top:1px solid #e6e2dc;margin:18px 0}
        .wc{background:#fefce8;color:#713f12;border:1px solid #fde68a;border-radius:4px;padding:10px 16px;font-size:14px;font-weight:500;line-height:1.4}
        .green{color:#16a34a}.red{color:#dc2626}
        @keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .fu{animation:fu .35s ease forwards}
        @media(max-width:680px){
          .g4{grid-template-columns:1fr 1fr!important}
          .g2{grid-template-columns:1fr!important}
          .ptable{grid-template-columns:72px 1fr 88px 70px 58px!important}
          .ptable .hide-mobile{display:none!important}
        }
      `}</style>

      {/* ── Header ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e6e2dc', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '0 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '16px 0 0', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: '#666', marginBottom: 4 }}>Investment OS · Live</div>
              <div className="serif" style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>Portfolio Dashboard</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 3 }}>Total Net Worth</div>
              <div className="serif" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>{fmtTWD(c.netWorth)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <span style={{ fontSize: 11, color: '#666' }}>USD/TWD {c.fx.toFixed(2)} · {lastUpdated?.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
                <button onClick={refetch} style={{ background: 'none', border: '1.5px solid #e6e2dc', borderRadius: 4, padding: '5px 11px', fontSize: 13, fontWeight: 600, color: '#444', cursor: 'pointer' }}>↻</button>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', overflowX: 'auto', marginTop: 2, WebkitOverflowScrolling: 'touch' }}>
            {TABS.map(([k, v]) => <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{v}</button>)}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: '0 auto', padding: '18px 16px 80px' }}>

        {/* Warnings */}
        {c.warns.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
            {c.warns.map((w, i) => <div key={i} className="wc">⚠ {w}</div>)}
          </div>
        )}

        {/* ══ OVERVIEW ══ */}
        {tab === 'overview' && (
          <div className="fu" style={{ display: 'grid', gap: 14 }}>

            {/* Economic Regime */}
            <div className="card" style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 12, color: '#555', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' }}>經濟象限</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{c.quadrant}</div>
              </div>
              <div style={{ fontSize: 14 }}>{c.stressStatus}</div>
            </div>

            {/* KPIs */}
            <div className="g4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
              {[
                { lbl: '可投資基礎', val: fmtTWD(c.base), sub: 'Cash + Investment' },
                { lbl: '未實現損益', val: `${c.totPnL >= 0 ? '+' : ''}${fmtTWD(c.totPnL)}`, sub: '所有持倉', green: c.totPnL > 0, red: c.totPnL < 0 },
                { lbl: '月被動收益', val: fmtTWD(c.monthly), sub: '利息＋股息（估）' },
                { lbl: '年化收益率', val: fmtPct(c.annYield), sub: `對可投資基礎` },
              ].map((k, i) => (
                <div key={i} className="card">
                  <div className="lbl">{k.lbl}</div>
                  <div className="serif" style={{ fontSize: 17, fontWeight: 700, color: k.green ? '#16a34a' : k.red ? '#dc2626' : '#1a1a1a', margin: '4px 0', lineHeight: 1.3 }}>{k.val}</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* Goal */}
            <div className="card" style={{ padding: '14px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, alignItems: 'flex-end' }}>
                <div>
                  <div className="lbl" style={{ marginBottom: 2 }}>目標淨資產進度</div>
                  <div style={{ fontSize: 14, color: '#444' }}>{fmtTWD(c.netWorth)} <span style={{ color: '#888' }}>/ {fmtTWD(c.targetNW)}</span></div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="serif" style={{ fontSize: 20, fontWeight: 700 }}>{fmtPct(c.goalPct)}</div>
                  <div style={{ fontSize: 12, color: '#666' }}>{c.estMonths ? `預估 ${c.estMonths} 個月達成` : '計算中'}</div>
                </div>
              </div>
              <div className="bar" style={{ height: 8 }}>
                <div className="bf" style={{ width: mounted ? `${Math.min(c.goalPct, 1) * 100}%` : '0%', background: '#1a1a1a', opacity: .85 }} />
              </div>
            </div>

            <div className="g2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {/* All Weather */}
              <div className="card">
                <div className="lbl">All Weather 配置</div>
                {c.awRows.map((r, i) => (
                  <div key={i} style={{ marginBottom: i < 2 ? 20 : 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_COLOR[r.cat] }} />
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{r.cat}</span>
                        <span className={`bdg ${r.gap > 0.01 ? 'buy' : r.gap < -0.01 ? 'over' : 'ok'}`}>{r.gap > 0.01 ? 'BUY' : r.gap < -0.01 ? 'OVER' : 'OK'}</span>
                      </div>
                      <span style={{ fontSize: 13, color: '#444' }}>{fmtPct(r.cur)} <span style={{ color: '#aaa' }}>/ {fmtPct(r.tgt)}</span></span>
                    </div>
                    <div className="bar"><div className="bf" style={{ width: mounted ? `${Math.min(r.cur / r.tgt, 1) * 100}%` : '0%', background: CAT_COLOR[r.cat], opacity: .7 }} /></div>
                    <div style={{ fontSize: 12, color: '#555', marginTop: 5 }}>{r.gap > 0 ? `缺口 ${fmtTWD(r.gapAmt)}` : `超配 ${fmtPct(Math.abs(r.gap))}`}</div>
                  </div>
                ))}
              </div>

              {/* Right column */}
              <div style={{ display: 'grid', gap: 14 }}>
                {/* TWD/USD */}
                <div className="card">
                  <div className="lbl">台美資產分布</div>
                  {[
                    { lbl: '台幣資產', val: c.twdTotal, pct: c.twdPct, color: '#2563eb' },
                    { lbl: '美元資產', val: c.usdTotal, pct: c.usdPct, color: '#d97706' },
                  ].map((r, i) => (
                    <div key={i} style={{ marginBottom: i === 0 ? 14 : 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{r.lbl}</span>
                        <span style={{ fontSize: 13, color: '#444' }}>{fmtPct(r.pct)}</span>
                      </div>
                      <div className="bar"><div className="bf" style={{ width: mounted ? `${r.pct * 100}%` : '0%', background: r.color, opacity: .65 }} /></div>
                      <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>{fmtTWD(r.val)}</div>
                    </div>
                  ))}
                </div>

                {/* Passive Income */}
                <div className="card">
                  <div className="lbl">被動收益（估算）</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                    {[{ lbl: '利息 / yr', v: c.annInt }, { lbl: '股息 / yr', v: c.annDiv }].map((r, i) => (
                      <div key={i}>
                        <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>{r.lbl}</div>
                        <div className="serif" style={{ fontSize: 15, fontWeight: 700 }}>{fmtTWD(r.v)}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>月被動收益</div>
                  <div className="serif" style={{ fontSize: 18, fontWeight: 700 }}>{fmtTWD(c.monthly)}</div>
                </div>
              </div>
            </div>

            {/* Monthly contribution */}
            {(c.monthSalary > 0 || c.monthBonus > 0 || c.monthDividend > 0) && (
              <div className="card">
                <div className="lbl">本月資金流入</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
                  {[
                    { lbl: '薪資', v: c.monthSalary },
                    { lbl: '獎金', v: c.monthBonus },
                    { lbl: '股息實收', v: c.monthDividend },
                    { lbl: '其他', v: c.monthOther },
                  ].map((r, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>{r.lbl}</div>
                      <div className="serif" style={{ fontSize: 15, fontWeight: 700, color: r.v > 0 ? '#1a1a1a' : '#aaa' }}>{r.v > 0 ? fmtTWD(r.v) : '—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right' }}>股價來源：Google Sheets GOOGLEFINANCE · 約 15-20 分鐘更新 · 點「↻」重新抓取</div>
          </div>
        )}

        {/* ══ POSITIONS ══ */}
        {tab === 'positions' && (
          <div className="fu card">
            <div className="lbl">持倉明細</div>
            <div className="ptable" style={{ display: 'grid', gridTemplateColumns: '72px 1fr 96px 90px 60px 58px', gap: 8, paddingBottom: 10, borderBottom: '2px solid #f0ede8' }}>
              {['Ticker', '名稱', '市值', '損益', '報酬%', '配置%'].map(h => (
                <div key={h} style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#555' }}>{h}</div>
              ))}
            </div>
            {c.positions.map((p, i) => (
              <div key={i} className="ptable" style={{ display: 'grid', gridTemplateColumns: '72px 1fr 96px 90px 60px 58px', gap: 8, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #f0ede8' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{p.ticker}</div>
                  <div style={{ fontSize: 11, color: CAT_COLOR[p.category], marginTop: 2, fontWeight: 600 }}>{p.category}</div>
                </div>
                <div>
                  <div style={{ fontSize: 13, color: '#222' }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>
                    {p.sh.toLocaleString()} 股 · 均 {fmtNum(p.avgCost)} {p.currency}
                    {p.cp > 0 && <span style={{ marginLeft: 6 }}>· 現 {fmtNum(p.cp)}</span>}
                  </div>
                </div>
                <div className="serif" style={{ fontSize: 13, fontWeight: 700 }}>{fmtTWD(p.mvTWD)}</div>
                <div className="serif" style={{ fontSize: 13, fontWeight: 700, color: p.pnlTWD >= 0 ? '#16a34a' : '#dc2626' }}>
                  {p.pnlTWD >= 0 ? '+' : ''}{fmtTWD(p.pnlTWD)}
                </div>
                <div style={{ fontSize: 13, color: p.ret >= 0 ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                  {p.ret >= 0 ? '+' : ''}{fmtPct(p.ret)}
                </div>
                <div style={{ fontSize: 13, color: '#444', fontWeight: 500 }}>{fmtPct(p.portPct)}</div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 14, borderTop: '2px solid #f0ede8', marginTop: 4 }}>
              <span style={{ fontSize: 13, color: '#555', fontWeight: 600 }}>總投資市值</span>
              <span className="serif" style={{ fontSize: 17, fontWeight: 700 }}>{fmtTWD(c.totInv)}</span>
            </div>
          </div>
        )}

        {/* ══ REBALANCE ══ */}
        {tab === 'rebalance' && (
          <div className="fu" style={{ display: 'grid', gap: 14 }}>
            {/* AW Gap */}
            <div className="card">
              <div className="lbl">All Weather 缺口</div>
              <div style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>可動用現金 {fmtTWD(c.avail)}</div>
              {c.awRows.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: i < c.awRows.length - 1 ? '1px solid #f0ede8' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: CAT_COLOR[r.cat] }} />
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{r.cat}</div>
                      <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>現況 {fmtPct(r.cur)} → 目標 {fmtPct(r.tgt)}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`bdg ${r.gap > 0.01 ? 'buy' : r.gap < -0.01 ? 'over' : 'ok'}`}>{r.gap > 0.01 ? 'BUY' : r.gap < -0.01 ? 'OVER' : 'OK'}</span>
                    <div className="serif" style={{ fontSize: 15, fontWeight: 700, marginTop: 5, color: r.gap > 0 ? '#16a34a' : '#dc2626' }}>
                      {r.gap > 0 ? '+' : ''}{fmtTWD(r.gapAmt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Deployment suggestion */}
            <div className="card">
              <div className="lbl">戰略部署建議（{fmtTWD(c.deployAmt)}）</div>
              {c.positions.filter(p => { const r = c.awRows.find(r => r.cat === p.category); return r && r.gap > 0.01; }).map((p, i, arr) => {
                const r = c.awRows.find(r => r.cat === p.category)!;
                const catPos = arr.filter(x => x.category === p.category);
                const tot = catPos.reduce((s, x) => s + x.portPct, 0);
                const budget = Math.min(c.deployAmt, r.gapAmt) * (tot > 0 ? p.portPct / tot : 1 / catPos.length);
                const pTWD = p.currency === 'USD' ? p.cp * c.fx : p.cp;
                const sh = pTWD > 0 ? Math.floor(budget / pTWD) : 0;
                if (sh <= 0) return null;
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #f0ede8' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="bdg buy">BUY</span>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700 }}>{p.ticker}</div>
                        <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{p.name} · <strong style={{ color: '#1a1a1a' }}>{sh} 股</strong> · {p.currency === 'USD' ? `$${fmtNum(p.cp)} USD` : `NT$ ${fmtNum(p.cp, 0)}`}</div>
                      </div>
                    </div>
                    <div className="serif" style={{ fontSize: 15, fontWeight: 700, color: '#16a34a' }}>{fmtTWD(sh * pTWD)}</div>
                  </div>
                );
              }).filter(Boolean)}
            </div>

            {/* DCA Plan */}
            <div className="card">
              <div className="lbl">月定投計劃（{fmtTWD(c.fixedDCA)}）</div>
              {c.dcaPlan.map((d, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: i < c.dcaPlan.length - 1 ? '1px solid #f0ede8' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="bdg buy">DCA</span>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{d.ticker}</div>
                      <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{d.name} · <strong style={{ color: '#1a1a1a' }}>{d.shares} 股</strong> · 預算 {fmtTWD(d.budget)}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="serif" style={{ fontSize: 15, fontWeight: 700 }}>{fmtTWD(d.amt)}</div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>殘差 {fmtTWD(d.residual)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ SIMULATE ══ */}
        {tab === 'simulate' && (
          <div className="fu" style={{ display: 'grid', gap: 14 }}>
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <div className="lbl" style={{ marginBottom: 0 }}>多標的加倉模擬</div>
                <button className="bp" onClick={() => setSimRows(r => [...r, { ticker: '6208', shares: 10 }])}>＋ 新增標的</button>
              </div>
              <div style={{ background: '#faf9f7', border: '1px solid #e6e2dc', borderRadius: 4, padding: '12px 16px', marginBottom: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#555', marginBottom: 8 }}>再平衡參考缺口</div>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                  {c.awRows.filter(r => r.gap > 0.01).map((r, i) => (
                    <div key={i} style={{ fontSize: 13 }}>
                      <span style={{ color: CAT_COLOR[r.cat], fontWeight: 700 }}>{r.cat}</span>
                      <span style={{ color: '#555', marginLeft: 4 }}>缺 {fmtTWD(r.gapAmt)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 44px', gap: 10, marginBottom: 10 }}>
                {['選擇標的', '買入股數', ''].map((h, i) => <div key={i} style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#555' }}>{h}</div>)}
              </div>
              {simRows.map((row, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 44px', gap: 10, marginBottom: 12, alignItems: 'center' }}>
                  <select className="inp" value={row.ticker} onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, ticker: e.target.value } : x))}>
                    {c.positions.map(p => <option key={p.ticker} value={String(p.ticker)}>{p.ticker} · {p.name}</option>)}
                  </select>
                  <input type="number" className="inp" value={row.shares} min={0} onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, shares: Number(e.target.value) } : x))} />
                  <button className="bd" onClick={() => setSimRows(r => r.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>

            {simResults.length > 0 && (
              <div className="card">
                <div className="lbl">模擬結果</div>
                {simResults.map((r, i) => (
                  <div key={i} style={{ background: '#faf9f7', border: '1px solid #e6e2dc', borderRadius: 4, padding: '16px', marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
                      <div><span style={{ fontSize: 15, fontWeight: 700 }}>{r.ticker}</span><span style={{ fontSize: 13, color: '#555', marginLeft: 8 }}>{r.name} · 買入 {r.qty} 股</span></div>
                      <div className="serif" style={{ fontSize: 15, fontWeight: 700, color: '#16a34a' }}>{fmtTWD(r.buyAmt)}</div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
                      {[
                        { lbl: '新均成本', b: `${fmtNum(r.avgCost)} ${r.currency}`, a: `${fmtNum(r.nAvg)} ${r.currency}` },
                        { lbl: '持股數', b: `${r.sh} 股`, a: `${r.nSh} 股` },
                        { lbl: '未實現損益', b: `${r.pnlTWD >= 0 ? '+' : ''}${fmtTWD(r.pnlTWD)}`, a: `${r.nPnL >= 0 ? '+' : ''}${fmtTWD(r.nPnL)}` },
                        { lbl: '報酬率', b: `${r.ret >= 0 ? '+' : ''}${fmtPct(r.ret)}`, a: `${r.nRet >= 0 ? '+' : ''}${fmtPct(r.nRet)}` },
                      ].map((cc, j) => (
                        <div key={j}>
                          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#555', marginBottom: 5 }}>{cc.lbl}</div>
                          <div style={{ fontSize: 12, color: '#aaa', textDecoration: 'line-through', marginBottom: 3 }}>{cc.b}</div>
                          <div style={{ fontSize: 14, fontWeight: 700 }}>{cc.a}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="hr" />
                <div className="lbl">執行後 All Weather 配置</div>
                {Object.entries(c.awTargets).map(([cat, tgt], i) => {
                  const bef = c.base > 0 ? c.awCur[cat] / c.base : 0;
                  const aft = simNewBase > 0 ? simNewAW[cat] / simNewBase : 0;
                  return (
                    <div key={i} style={{ marginBottom: i < 2 ? 16 : 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_COLOR[cat] }} />
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{cat}</span>
                        </div>
                        <span style={{ fontSize: 13 }}>
                          <span style={{ color: '#555' }}>{fmtPct(bef)}</span>
                          <span style={{ color: '#ccc', margin: '0 6px' }}>→</span>
                          <span style={{ fontWeight: 700, color: CAT_COLOR[cat] }}>{fmtPct(aft)}</span>
                          <span style={{ color: '#aaa' }}> / {fmtPct(tgt)}</span>
                        </span>
                      </div>
                      <div className="bar"><div className="bf" style={{ width: `${Math.min(aft / tgt, 1) * 100}%`, background: CAT_COLOR[cat], opacity: .65 }} /></div>
                    </div>
                  );
                })}
                <div className="hr" />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div><div style={{ fontSize: 12, color: '#555', marginBottom: 3 }}>模擬總投入</div><div className="serif" style={{ fontSize: 19, fontWeight: 700 }}>{fmtTWD(simTotal)}</div></div>
                  <div style={{ textAlign: 'right' }}><div style={{ fontSize: 12, color: '#555', marginBottom: 3 }}>執行後可動用現金</div><div className="serif" style={{ fontSize: 19, fontWeight: 700, color: c.avail - simTotal < 0 ? '#dc2626' : '#1a1a1a' }}>{fmtTWD(c.avail - simTotal)}</div></div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══ REALIZED ══ */}
        {tab === 'realized' && (
          <div className="fu card">
            <div className="lbl">已實現績效</div>
            {c.realizedRows.length === 0
              ? <div style={{ fontSize: 14, color: '#666', padding: '16px 0' }}>尚無已出場紀錄</div>
              : c.realizedRows.map((r, i) => (
                <div key={i} style={{ padding: '18px 0', borderBottom: i < c.realizedRows.length - 1 ? '1px solid #f0ede8' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{String(r.ticker)} · {String(r.instrument)}</div>
                      <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>持有 {r.holdingDays} 天</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="serif" style={{ fontSize: 17, fontWeight: 700, color: r.pnlTWD >= 0 ? '#16a34a' : '#dc2626' }}>
                        {r.pnlTWD >= 0 ? '+' : ''}{fmtTWD(r.pnlTWD)}
                      </div>
                      <div style={{ fontSize: 13, color: '#555', marginTop: 3 }}>報酬率 {fmtPct(r.returnPct)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
                    {[
                      { lbl: '買入成本', v: fmtTWD(r.buyCost) },
                      { lbl: '賣出金額', v: fmtTWD(r.sellValue) },
                      { lbl: '年化報酬', v: fmtPct(r.annReturn) },
                      { lbl: '年化 Alpha', v: fmtPct(r.annAlpha) },
                    ].map((cc, j) => (
                      <div key={j}>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#555', marginBottom: 5 }}>{cc.lbl}</div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a' }}>{cc.v}</div>
                      </div>
                    ))}
                  </div>
                  {r.notes && <div style={{ fontSize: 13, color: '#555', marginTop: 12, fontStyle: 'italic' }}>「{r.notes}」</div>}
                </div>
              ))
            }
          </div>
        )}

      </div>
    </div>
  );
}