'use client';
import { useState, useEffect, useRef, useCallback } from 'react';

const fmtTWD = (n: number) => `NT$ ${Math.round(n).toLocaleString('zh-TW')}`;
const fmtNT = (n: number) => Math.round(n).toLocaleString('zh-TW'); // 純數字，單位另標
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtNum = (n: number, d = 2) => Number(n).toFixed(d);
const toF = (v: unknown): number => parseFloat(String(v ?? '0').replace(/,/g, '')) || 0;

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
interface AWRow { cat: string; tgt: number; cur: number; gap: number; gapAmt: number; mv: number; }
interface SimRow {
  mode: 'list' | 'custom'; ticker: string; shares: number;
  customTicker: string; customPrice: number; customCurrency: string;
}
interface NWPoint { m: string; val: number; }

// ── Data fetching ────────────────────────────────────────
function usePortfolioData() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sheets', {
        headers: { 'x-wm-secret': process.env.NEXT_PUBLIC_WM_SECRET || '' }
      });
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

// ── Compute ──────────────────────────────────────────────
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

  const benchmarkName = String(cfg['機會成本基準'] || 'VOO');
  const benchmarkAnnRet = toF(cfg['機會成本基準年報酬率']) || 0;

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

  const monthMap = new Map<string, unknown[]>();
  bankRows.forEach(r => {
    const d = new Date(String(r[0]));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthMap.set(key, r);
  });
  const nwHistory: NWPoint[] = [...monthMap.values()].slice(-6).map(r => ({
    m: `${new Date(String(r[0])).getMonth() + 1}月`,
    val: toF(r[9]),
  }));

  const twdStocks = positions.filter(p => p.currency === 'TWD').reduce((s, p) => s + p.mvTWD, 0);
  const usdStocks = positions.filter(p => p.currency === 'USD').reduce((s, p) => s + p.mvTWD, 0);
  const twdTotal = latestBank + twdStocks;
  const usdTotal = usdStocks;
  const twdPct = netWorth > 0 ? twdTotal / netWorth : 0;
  const usdPct = netWorth > 0 ? usdTotal / netWorth : 0;

  // awCur.Deflation 起始為可動用現金，再加上 category=Deflation 的持倉（TLT）
  const awCur: Record<string, number> = { Growth: 0, Inflation: 0, Deflation: avail };
  positions.forEach(p => { awCur[p.category] = (awCur[p.category] || 0) + p.mvTWD; });
  const awRows: AWRow[] = Object.entries(awTargets).map(([cat, tgt]) => ({
    cat, tgt,
    cur: base > 0 ? awCur[cat] / base : 0,
    gap: tgt - (base > 0 ? awCur[cat] / base : 0),
    gapAmt: (tgt - (base > 0 ? awCur[cat] / base : 0)) * base,
    mv: awCur[cat] || 0,
  }));

  // ── 新增：Deflation 拆解（公債 TLT vs 可動用現金）──
  const deflTotal = awCur.Deflation || 0;
  const deflTLT = Math.max(0, deflTotal - avail); // TLT 市值 = Deflation 總額扣現金
  const deflCash = avail;
  const tltPctOfDefl  = deflTotal > 0 ? deflTLT / deflTotal : 0;
  const cashPctOfDefl = deflTotal > 0 ? deflCash / deflTotal : 0;
  const tltPctOfBase  = base > 0 ? deflTLT / base : 0;
  const cashPctOfBase = base > 0 ? deflCash / base : 0;

  // ── 新增：補滿 AW 缺口需要的現金 + 補完後剩餘部署空間 ──
  const needToFill = awRows.filter(r => r.gap > 0).reduce((s, r) => s + r.gapAmt, 0);
  const remainingDryPowder = avail - needToFill;

  // ── 新增：健康度一句話總結 ──
  const overRow = awRows.filter(r => r.gap < 0).sort((a, b) => a.gap - b.gap)[0]; // 超配最多
  const underRow = awRows.filter(r => r.gap > 0).sort((a, b) => b.gap - a.gap)[0]; // 不足最多
  const imbalanceThreshold = toF(cfg['失衡警戒幅度']) || 0.15;
  const isImbalanced = awRows.some(r => Math.abs(r.gap) >= imbalanceThreshold);
  let healthTitle = '配置健康，維持現狀';
  let healthDetail = '三大類皆在目標範圍內，無需立即調整。';
  if (isImbalanced && underRow) {
    healthTitle = `配置失衡，建議優先補 ${underRow.cat}`;
    const parts: string[] = [];
    if (overRow) parts.push(`${overRow.cat} 超配 ${fmtPct(Math.abs(overRow.gap))}`);
    if (underRow) parts.push(`${underRow.cat} 不足 ${fmtPct(Math.abs(underRow.gap))}`);
    const dpTxt = remainingDryPowder >= 0
      ? `現金足夠補滿缺口，補完餘約 ${fmtNT(remainingDryPowder)}。`
      : `現金不足補滿全部缺口，缺口約 ${fmtNT(-remainingDryPowder)}。`;
    healthDetail = `${parts.join('、')}。${dpTxt}`;
  }

  const avgRate = banks.length > 0 ? banks.reduce((s, b) => s + b.rate, 0) / banks.length : 0;
  const annInt = latestBank * avgRate;
  const annDiv = positions.reduce((s, p) => s + p.mvTWD * (p.yield || 0), 0);
  const monthly = (annInt + annDiv) / 12;
  const annYield = base > 0 ? (annInt + annDiv) / base : 0;

  const now = new Date();
  const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const etfTickers = new Set(tickers.filter(t => !['2059', '6584'].includes(t.ticker)).map(t => String(t.ticker)));
  const rolling12Div = caps
    .filter(r => {
      const d = new Date(String(r[0]));
      const type = String(r[1] || '');
      const note = String(r[3] || '');
      return type.startsWith('Dividend') && d >= twelveMonthsAgo && etfTickers.has(note);
    })
    .reduce((s, r) => s + toF(r[2]), 0);
  const etfDivGap = annDiv > 0 ? (rolling12Div - annDiv) / annDiv : 0;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthCaps = caps.filter(r => { const d = new Date(String(r[0])); return d >= monthStart; });
  const monthSalary   = monthCaps.filter(r => r[1] === 'Salary').reduce((s, r) => s + toF(r[2]), 0);
  const monthBonus    = monthCaps.filter(r => r[1] === 'Bonus').reduce((s, r) => s + toF(r[2]), 0);
  const monthDividend = monthCaps.filter(r => String(r[1]).startsWith('Dividend')).reduce((s, r) => s + toF(r[2]), 0);
  const monthOther    = monthCaps.filter(r => r[1] === 'Non-leaving pay').reduce((s, r) => s + toF(r[2]), 0);
  const monthBuyAmt = trades
    .filter(r => { const d = new Date(String(r[0])); return d >= monthStart && r[3] === 'Buy'; })
    .reduce((s, r) => s + toF(r[12]), 0);

  const goalPct = targetNW > 0 ? netWorth / targetNW : 0;
  const recent6 = bankRows.slice(-7);
  let monthlyGrowth = 0;
  if (recent6.length >= 2) {
    const diffs = [];
    for (let i = 1; i < recent6.length; i++) diffs.push(toF(recent6[i][9]) - toF(recent6[i-1][9]));
    monthlyGrowth = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  }
  const estMonths = monthlyGrowth > 0 ? Math.ceil((targetNW - netWorth) / monthlyGrowth) : null;

  const dcaPlan = [
    { ticker: '006208', name: '富邦台50', budget: fixedDCA * dca6208Pct, cp: getPrice(cfg, '006208') },
    { ticker: '00878',  name: '國泰ESG',  budget: fixedDCA * dca878Pct,  cp: getPrice(cfg, '00878') },
  ].map(d => ({ ...d, shares: d.cp > 0 ? Math.floor(d.budget / d.cp) : 0 }))
   .map(d => ({ ...d, amt: d.shares * d.cp, residual: d.budget - d.shares * d.cp }));

  const stressStatus = String(cfg['Stress Regime狀態'] || cfg['Stress狀態'] || '');
  const isStress = stressStatus.includes('⚠') || stressStatus.includes('Stress');

  const warns: string[] = [];
  if (isStress) {
    warns.push(`⚠ Stress Regime 觸發（象限 Q3 確認）：① 暫停增加高波動成長資產 ② 提高 Deflation 現金比重 ③ 新增資金優先保留現金`);
  }
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
    if (Math.abs(r.gap) >= imbalanceThreshold)
      warns.push(`${r.cat} 偏離目標 ${fmtPct(Math.abs(r.gap))}，建議再平衡`);
  });
  if (latestBank > 0 && avail <= (toF(cfg['現金水位警戒線']) || 500000))
    warns.push(`可動用現金 ${fmtTWD(avail)}，低於警戒線`);

  const growthS     = String(cfg['成長方向(短期)'] || '');
  const inflS       = String(cfg['通膨方向(短期)'] || '');
  const quadrant    = String(cfg['當前象限']        || '—');
  const quadConfirm = String(cfg['象限確認']        || '');
  const fxTrend     = String(cfg['匯率趨勢']        || '');
  const totPnL = positions.reduce((s, p) => s + p.pnlTWD, 0);
  const totRet = positions.reduce((s, p) => s + p.costTWD, 0);
  const totRetPct = totRet > 0 ? totPnL / totRet : 0;

  const realizedRows = realized.map(r => ({
    ticker: r[0], instrument: r[1], holdingDays: toF(r[7]),
    buyCost: toF(r[8]), sellValue: toF(r[9]), pnlTWD: toF(r[10]),
    returnPct: toF(r[11]), annReturn: toF(r[12]),
    benchmark: toF(r[13]), annAlpha: toF(r[15]), notes: String(r[16] || ''),
  }));

  const realizedAvgAnnReturn = realizedRows.length > 0
    ? realizedRows.reduce((s, r) => s + r.annReturn, 0) / realizedRows.length
    : null;
  const realizedTotalPnL = realizedRows.reduce((s, r) => s + r.pnlTWD, 0);

  return {
    cfg, fx, tickers, positions, totInv, latestBank, avail, base, netWorth,
    twdTotal, usdTotal, twdPct, usdPct,
    awRows, awCur, awTargets, totPnL, totRetPct, monthly, annInt, annDiv, annYield,
    goalPct, estMonths, targetNW, deployAmt, fixedDCA,
    warns, growthS, inflS, quadrant, quadConfirm, fxTrend,
    realizedRows, dcaPlan, nwHistory,
    monthSalary, monthBonus, monthDividend, monthOther,
    monthBuyAmt, rolling12Div, etfDivGap,
    benchmarkName, benchmarkAnnRet, realizedAvgAnnReturn, realizedTotalPnL,
    isStress,
    // 新增衍生值
    deflTLT, deflCash, tltPctOfDefl, cashPctOfDefl, tltPctOfBase, cashPctOfBase,
    needToFill, remainingDryPowder, healthTitle, healthDetail, isImbalanced,
  };
}

// ── Visual components ────────────────────────────────────
function Skeleton({ w = '100%', h = 14, r = 4 }: { w?: string | number; h?: number; r?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, borderRadius: r }} />;
}
function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 3, padding: '14px 16px' }}>
      <Skeleton h={10} w="50%" />
      <div style={{ marginTop: 8 }}><Skeleton h={18} w="70%" /></div>
      {lines > 1 && <div style={{ marginTop: 6 }}><Skeleton h={10} w="40%" /></div>}
    </div>
  );
}

function DonutChart({ segs, size = 110, thick = 16 }: { segs: { val: number; color: string }[]; size?: number; thick?: number }) {
  const r = (size - thick) / 2;
  const cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = segs.reduce((s, d) => s + d.val, 0);
  if (total <= 0) return null;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e8e4de" strokeWidth={thick} />
      {segs.map((s, i) => {
        const len = (s.val / total) * C;
        const el = (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={thick}
            strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`} opacity={0.8} />
        );
        offset += len;
        return el;
      })}
    </svg>
  );
}

function LineChart({ data }: { data: NWPoint[] }) {
  if (data.length < 2) return null;
  const vals = data.map(d => d.val);
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1;
  const W = 500, H = 70, px = 10, py = 8;
  const pts = data.map((d, i) => ({
    x: px + (i / (data.length - 1)) * (W - px * 2),
    y: py + (H - py * 2) - ((d.val - min) / range) * (H - py * 2),
    m: d.m,
  }));
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z`;
  const latestVal = data[data.length - 1].val;
  const firstVal = data[0].val;
  const diff = latestVal - firstVal;
  const diffPct = firstVal > 0 ? (diff / firstVal * 100).toFixed(1) : '0.0';
  const isUp = diff >= 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>
          現金餘額趨勢（近 {data.length} 月）
        </div>
        <div style={{ fontSize: 12, color: isUp ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
          {isUp ? '+' : ''}{diffPct}% {isUp ? '↑' : '↓'}
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#bbb', marginBottom: 6 }}>＊僅反映銀行現金水位，不含股票市值</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H + 14}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9a7b4f" stopOpacity={0.10} />
            <stop offset="100%" stopColor="#9a7b4f" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#nwGrad)" />
        <path d={linePath} fill="none" stroke="#9a7b4f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={i === pts.length - 1 ? 4 : 2.5} fill="#9a7b4f" opacity={i === pts.length - 1 ? 0.9 : 0.4} />
            <text x={p.x} y={H + 13} textAnchor="middle" style={{ fontSize: '10px', fill: '#aaa', fontFamily: "'DM Sans', system-ui" }}>{p.m}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Dashboard ────────────────────────────────────────────
export default function Dashboard() {
  const { data, loading, error, lastUpdated, refetch } = usePortfolioData();

  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('ios_dash_tab') || 'overview'; } catch { return 'overview'; }
  });
  const handleTab = (k: string) => {
    setTab(k);
    try { localStorage.setItem('ios_dash_tab', k); } catch {}
  };

  const [mounted, setMounted] = useState(false);
  const [simRows, setSimRows] = useState<SimRow[]>([
    { mode: 'list', ticker: 'QQQM', shares: 5,  customTicker: '', customPrice: 0, customCurrency: 'USD' },
    { mode: 'list', ticker: 'VOO',  shares: 2,  customTicker: '', customPrice: 0, customCurrency: 'USD' },
  ]);

  const [pullY, setPullY] = useState(0);
  const touchStartY = useRef(0);
  const PULL_THRESHOLD = 64;
  const stableRefetch = useCallback(refetch, []);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => { touchStartY.current = e.touches[0].clientY; };
    const onTouchMove = (e: TouchEvent) => {
      if (window.scrollY > 0) return;
      const dy = e.touches[0].clientY - touchStartY.current;
      if (dy > 0) setPullY(Math.min(dy * 0.5, PULL_THRESHOLD + 8));
    };
    const onTouchEnd = () => {
      if (pullY >= PULL_THRESHOLD) stableRefetch();
      setPullY(0);
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [pullY, stableRefetch]);

  useEffect(() => { setTimeout(() => setMounted(true), 150); }, []);
  const c = compute(data);

  if (loading) return (
    <div style={{ minHeight: '100vh', background: '#f7f6f3', fontFamily: "'DM Sans', system-ui" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        :root{--line:#e3ddd0}
        @keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
        .skeleton{background:linear-gradient(90deg,#ede9e3 25%,#f5f2ee 50%,#ede9e3 75%);background-size:800px 100%;animation:shimmer 1.4s ease-in-out infinite;border-radius:3px}
      `}</style>
      <div style={{ background: '#fff', borderBottom: '1px solid #e3ddd0', padding: '15px 16px 0' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 14 }}>
            <div><Skeleton w={120} h={10} /><div style={{ marginTop: 8 }}><Skeleton w={200} h={20} /></div></div>
          </div>
          <div style={{ display: 'flex', gap: 4, paddingBottom: 2 }}>
            {[80, 60, 80, 60, 60].map((w, i) => <span key={i}><Skeleton w={w} h={14} r={3} /></span>)}
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '22px 18px 80px', display: 'grid', gap: 14 }}>
        <SkeletonCard lines={2} />
        <SkeletonCard lines={1} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <SkeletonCard lines={3} /><SkeletonCard lines={3} />
        </div>
      </div>
    </div>
  );

  if (error) return (
    <div style={{ minHeight: '100vh', background: '#f7f6f3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, fontFamily: 'system-ui', padding: 32 }}>
      <div style={{ color: '#dc2626', fontSize: 15 }}>⚠ 無法載入：{error}</div>
      <button onClick={refetch} style={{ padding: '10px 24px', background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 15 }}>重試</button>
    </div>
  );
  if (!c) return null;

  const TABS = [['overview','總覽'],['positions','持倉'],['rebalance','再平衡'],['simulate','模擬'],['realized','績效']];

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

  const awSegs = c.awRows.map(r => ({ val: r.cur, color: CAT_COLOR[r.cat] }));

  return (
    <div style={{ minHeight: '100vh', background: '#f7f6f3', fontFamily: "'DM Sans', system-ui", color: '#1a1a1a' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        html{-webkit-text-size-adjust:100%}
        :root{
          --line:#e3ddd0; --line-soft:#ece7db; --gold:#9a7b4f; --ink-faint:#a39c8e;
        }
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
        .serif{font-family:'Libre Baskerville',Georgia,serif}
        .num{font-family:'Libre Baskerville',Georgia,serif;font-variant-numeric:tabular-nums}
        .card{background:#fff;border:1px solid var(--line);border-radius:3px;padding:24px;box-shadow:none}
        .card-hover{transition:border-color .25s}
        .card-hover:hover{border-color:#d6cdba}
        .card-cash{background:#f7fafc;border-color:#d8e3ec}
        .row-hover{transition:background .15s;border-radius:3px}
        .row-hover:hover{background:#faf9f7}
        @keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
        .skeleton{background:linear-gradient(90deg,#ede9e3 25%,#f5f2ee 50%,#ede9e3 75%);background-size:800px 100%;animation:shimmer 1.4s ease-in-out infinite;border-radius:3px}
        .eyebrow{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--ink-faint);font-weight:500}
        .lbl{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#666;margin-bottom:14px}
        .tab-btn{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;padding:15px 16px;border:none;background:none;cursor:pointer;color:var(--ink-faint);border-bottom:1.5px solid transparent;transition:all .25s;white-space:nowrap;font-family:'DM Sans',system-ui}
        .tab-btn.active{color:#1a1a1a;border-bottom-color:var(--gold)}
        .tab-btn:hover:not(.active){color:#333}
        .bdg{font-size:11px;font-weight:700;padding:3px 9px;border-radius:3px}
        .buy{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
        .over{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
        .ok{background:#f0f9ff;color:#0284c7;border:1px solid #bae6fd}
        .bar{background:#e8e4de;height:5px;border-radius:3px;overflow:hidden}
        .bf{height:100%;border-radius:3px;transition:width 1s cubic-bezier(.4,0,.2,1)}
        .inp{font-family:'DM Sans',system-ui;font-size:14px;background:#faf9f7;border:1.5px solid var(--line);color:#1a1a1a;padding:9px 12px;border-radius:3px;width:100%;outline:none}
        .inp:focus{border-color:#1a1a1a;background:#fff}
        .bp{font-family:'DM Sans',system-ui;font-size:13px;font-weight:600;padding:9px 16px;border-radius:3px;cursor:pointer;background:#1a1a1a;color:#fff;border:none}
        .bd-r{font-family:'DM Sans',system-ui;font-size:12px;padding:7px 11px;border-radius:3px;cursor:pointer;background:none;border:1.5px solid #fecaca;color:#dc2626}
        .hr{border:none;border-top:1px solid var(--line);margin:18px 0}
        .step-tag{font-size:10px;font-weight:700;letter-spacing:.1em;padding:3px 8px;border-radius:2px;text-transform:uppercase}
        .wc{background:#fefce8;color:#713f12;border:1px solid #fde68a;border-radius:3px;padding:10px 14px;font-size:13px;font-weight:500;line-height:1.55}
        .wc-stress{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:3px;padding:12px 14px;font-size:13px;font-weight:600;line-height:1.6}
        .layer{display:flex;align-items:center;gap:14px;margin:38px 2px 16px}
        .layer .lt{font-size:10px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--ink-faint);white-space:nowrap}
        .layer::after{content:'';flex:1;height:1px;background:var(--line)}
        .health{display:flex;align-items:flex-start;gap:12px;background:#fdf3f3;border:1px solid #f3d4d4;border-left:3px solid #dc2626;border-radius:3px;padding:14px 17px}
        .health.okk{background:#f1f7f3;border-color:#cfe3d6;border-left-color:#16a34a}
        .health .ht{font-size:14px;font-weight:700;color:#991b1b}
        .health.okk .ht{color:#15803d}
        .health .ha{font-size:12px;color:#a85858;margin-top:3px;line-height:1.5}
        .health.okk .ha{color:#5f8a6e}
        .hero{background:#fff;border:1px solid var(--line);border-radius:3px;padding:30px 28px}
        .hero-nw{font-size:38px;font-weight:700;line-height:1.05;letter-spacing:-.5px}
        .hero-sub{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:24px;padding-top:22px;border-top:1px solid var(--line-soft)}
        .hs-label{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:6px;font-weight:500}
        .hs-val{font-size:20px;font-weight:700}
        .cash-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:14px;border-bottom:1px solid #eee4e4}
        .cash-row.total{border-bottom:none;border-top:1px solid #e3d3d3;margin-top:3px;padding-top:13px}
        .cash-row .cl{color:#555}.cash-row .cv{font-weight:600;text-align:right}
        .aw-sub{margin:7px 0 0 14px;padding-left:10px;border-left:1px solid var(--line)}
        .aw-sub-row{display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;font-size:12px;gap:8px}
        .aw-sub-row .sl{color:#999;white-space:nowrap}
        .aw-sub-row .sv{color:#777;text-align:right}
        .aw-sub-row .sv .d{color:var(--gold);font-weight:600}
        .note{background:#faf9f7;border:1px solid var(--line-soft);border-left:2px solid var(--gold);border-radius:2px;padding:12px 14px;font-size:12px;color:#777;margin-top:14px;line-height:1.65}
        .note b{color:#444}
        @keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .fu{animation:fu .35s ease forwards}
        @media(min-width:681px){
          .g5{grid-template-columns:repeat(5,1fr)!important}
          .bottom-nav{display:none!important}
          .pos-detail{display:none!important}
        }
        @media(max-width:680px){
          .top-tabs{display:none!important}
          .hero-nw{font-size:32px!important}
          .g4{grid-template-columns:1fr 1fr!important}
          .g5{grid-template-columns:1fr 1fr!important}
          .g3{grid-template-columns:1fr!important}
          .g2{grid-template-columns:1fr!important}
          .lbl{font-size:12px!important}
          .wc{font-size:14px!important;padding:12px 14px!important}
          .wc-stress{font-size:14px!important;padding:12px 14px!important}
          .bdg{font-size:12px!important;padding:4px 10px!important}
          .step-tag{font-size:11px!important}
          .bp{font-size:15px!important;padding:11px 18px!important}
          .inp{font-size:16px!important;padding:11px 14px!important}
          .ptable-header{display:none!important}
          .ptable{
            display:grid!important;
            grid-template-columns:1fr auto!important;
            grid-template-areas:"ticker mv" "name pnl" "detail ret"!important;
            gap:4px 12px!important;
            padding:15px 6px!important;
          }
          .pos-ticker{grid-area:ticker}
          .pos-name{grid-area:name}
          .pos-name-sub{display:none!important}
          .pos-detail{display:block!important;grid-area:detail}
          .pos-mv{grid-area:mv;text-align:right}
          .pos-pnl{grid-area:pnl;text-align:right}
          .pos-ret{grid-area:ret;text-align:right}
          .bottom-nav{
            display:flex!important;position:fixed;bottom:0;left:0;right:0;
            background:#fff;border-top:1px solid var(--line);z-index:200;
            padding-bottom:env(safe-area-inset-bottom);
          }
          .bottom-nav button{
            flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
            gap:3px;padding:10px 4px 8px;border:none;background:none;cursor:pointer;
            font-family:'DM Sans',system-ui;font-size:11px;font-weight:600;
            letter-spacing:.04em;color:#999;border-top:2px solid transparent;transition:color .15s;
          }
          .bottom-nav button.active{color:#1a1a1a;border-top-color:var(--gold)}
          .bottom-nav button .nav-dot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:0;transition:opacity .15s}
          .bottom-nav button.active .nav-dot{opacity:1}
        }
      `}</style>

      {pullY > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', height: pullY, background: 'transparent', pointerEvents: 'none' }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#fff', border: '1.5px solid var(--line)', boxShadow: '0 2px 8px rgba(0,0,0,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, transform: `rotate(${(pullY / PULL_THRESHOLD) * 180}deg)`, transition: 'transform .05s', opacity: Math.min(pullY / PULL_THRESHOLD, 1) }}>↻</div>
        </div>
      )}

      {/* Header */}
      <div style={{ background: 'rgba(247,246,243,.9)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '0 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0' }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 2 }}>Investment OS · Live</div>
              <div className="serif" style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2, letterSpacing: '.02em' }}>Portfolio Dashboard</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="eyebrow">USD/TWD {c.fx.toFixed(2)} · {lastUpdated?.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span>
              <button onClick={refetch} style={{ background: 'none', border: '1.5px solid var(--line)', borderRadius: 3, padding: '4px 10px', fontSize: 13, fontWeight: 600, color: '#555', cursor: 'pointer' }}>↻</button>
            </div>
          </div>
          <div className="top-tabs" style={{ display: 'flex', overflowX: 'auto', WebkitOverflowScrolling: 'touch', gap: 2 }}>
            {TABS.map(([k, v]) => (
              <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => handleTab(k)}>{v}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: '0 auto', padding: '22px 18px 90px' }}>

        {/* Warnings */}
        {c.warns.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {c.warns.map((w, i) => (
              <div key={i} className={i === 0 && c.isStress ? 'wc-stress' : 'wc'}>{w}</div>
            ))}
          </div>
        )}

        {/* ══════════ OVERVIEW ══════════ */}
        {tab === 'overview' && (
          <div className="fu">

            {/* ① 主角區：身家三件事 */}
            <div className="hero">
              <div className="eyebrow" style={{ marginBottom: 8 }}>Total Net Worth · 總淨資產</div>
              <div className="num hero-nw">{fmtTWD(c.netWorth)}</div>
              <div className="hero-sub">
                <div>
                  <div className="hs-label">未實現損益</div>
                  <div className="num hs-val" style={{ color: c.totPnL >= 0 ? '#16a34a' : '#dc2626' }}>
                    {c.totPnL >= 0 ? '+' : ''}{fmtNT(c.totPnL)}
                  </div>
                  <div className="num" style={{ fontSize: 12, color: c.totPnL >= 0 ? '#16a34a' : '#dc2626', marginTop: 2 }}>
                    {c.totRetPct >= 0 ? '+' : ''}{fmtPct(c.totRetPct)}
                  </div>
                </div>
                <div>
                  <div className="hs-label">投資市值</div>
                  <div className="num hs-val">{fmtNT(c.totInv)}</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{c.positions.length} 個標的</div>
                </div>
              </div>
              <div style={{ marginTop: 22 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 9 }}>
                  <div className="hs-label" style={{ marginBottom: 0 }}>目標進度</div>
                  <div style={{ fontSize: 13, color: '#555' }}>
                    <span className="num" style={{ fontWeight: 700, fontSize: 15 }}>{fmtPct(c.goalPct)}</span>
                    {c.estMonths ? ` · 預估 ${c.estMonths} 個月` : ''}
                  </div>
                </div>
                <div className="bar" style={{ height: 5 }}>
                  <div className="bf" style={{ width: mounted ? `${Math.min(c.goalPct, 1) * 100}%` : '0%', background: 'var(--gold)' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <span className="num" style={{ fontSize: 11, color: '#999' }}>{fmtTWD(c.netWorth)}</span>
                  <span className="num" style={{ fontSize: 11, color: '#999' }}>目標 {fmtNT(c.targetNW)}</span>
                </div>
              </div>
            </div>

            {/* ② 健康度一句話（降級） */}
            <div style={{ marginTop: 14 }}>
              <div className={`health ${c.isImbalanced ? '' : 'okk'}`}>
                <span style={{ fontSize: 17 }}>{c.isImbalanced ? '⚠️' : '✓'}</span>
                <div><div className="ht">{c.healthTitle}</div><div className="ha">{c.healthDetail}</div></div>
              </div>
            </div>

            {/* 經濟象限（方向改中性灰） */}
            <div className="card card-hover" style={{ padding: '14px 18px', marginTop: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span className="eyebrow">經濟象限</span>
                  {c.growthS && <span style={{ fontSize: 13, color: '#555' }}>成長 <b style={{ color: '#1a1a1a' }}>{c.growthS}</b></span>}
                  {c.inflS && <span style={{ fontSize: 13, color: '#555' }}>通膨 <b style={{ color: '#1a1a1a' }}>{c.inflS}</b></span>}
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{c.quadrant}</span>
                  {c.quadConfirm && c.quadConfirm.includes('確認') && (
                    <span style={{ fontSize: 10, padding: '3px 10px', borderRadius: 2, fontWeight: 600, background: '#f0ebe0', color: '#6b6459', border: '1px solid var(--line)', letterSpacing: '.08em' }}>{c.quadConfirm}</span>
                  )}
                </div>
                {c.fxTrend && <span style={{ fontSize: 12, color: '#666' }}>匯率 {c.fxTrend}</span>}
              </div>
            </div>

            {/* ═══ 配置 ═══ */}
            <div className="layer"><span className="lt">Allocation · 配置</span></div>

            {/* 現金與部署空間 */}
            <div className="card card-hover card-cash">
              <div className="lbl">現金與部署空間</div>
              <div className="cash-row"><span className="cl">銀行總額</span><span className="cv num">{fmtNT(c.latestBank)}</span></div>
              <div className="cash-row"><span className="cl">− 不可動用（緊急金）</span><span className="cv num" style={{ color: '#999' }}>{fmtNT(c.latestBank - c.avail)}</span></div>
              <div className="cash-row"><span className="cl" style={{ fontWeight: 600, color: '#1a1a1a' }}>＝ 可動用現金</span><span className="cv num" style={{ fontSize: 16 }}>{fmtNT(c.avail)}</span></div>
              <div className="cash-row"><span className="cl">補滿 AW 缺口需要</span><span className="cv num" style={{ color: '#dc2626' }}>− {fmtNT(c.needToFill)}</span></div>
              <div className="cash-row total"><span className="cl" style={{ fontWeight: 700, color: '#1a1a1a' }}>補完後剩餘部署空間</span><span className="cv num" style={{ fontSize: 18, color: c.remainingDryPowder >= 0 ? '#16a34a' : '#dc2626' }}>{fmtNT(c.remainingDryPowder)}</span></div>
              <div style={{ fontSize: 11, color: '#aaa', marginTop: 10 }}>單位 NT$ ·「補滿缺口」以配置目標 % 為準</div>
            </div>

            {/* All Weather 配置（含金額並列 + Deflation 拆解） */}
            <div className="card card-hover" style={{ marginTop: 14 }}>
              <div className="lbl">All Weather 配置</div>
              <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
                <div style={{ flexShrink: 0, position: 'relative', width: 110, height: 110 }}>
                  <DonutChart segs={awSegs} size={110} thick={16} />
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="eyebrow" style={{ fontSize: 9 }}>Total</span>
                    <span className="num" style={{ fontSize: 13, fontWeight: 700 }}>100%</span>
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  {c.awRows.map((r, i) => (
                    <div key={i} style={{ marginBottom: i < c.awRows.length - 1 ? 14 : 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: CAT_COLOR[r.cat] }} />
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{r.cat}</span>
                          <span className={`bdg ${r.gap > 0.01 ? 'buy' : r.gap < -0.01 ? 'over' : 'ok'}`}>
                            {r.gap > 0.01 ? '偏低' : r.gap < -0.01 ? '過高' : '達標'}
                          </span>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span className="num" style={{ fontSize: 11, color: '#555' }}>{fmtPct(r.cur)} <span style={{ color: '#bbb' }}>/ {fmtPct(r.tgt)}</span></span>
                          <div className="num" style={{ fontSize: 12, fontWeight: 600, color: '#333', marginTop: 1 }}>{fmtNT(r.mv)}</div>
                        </div>
                      </div>
                      <div className="bar">
                        <div className="bf" style={{ width: mounted ? `${Math.min(r.cur / r.tgt, 1) * 100}%` : '0%', background: CAT_COLOR[r.cat], opacity: .7 }} />
                      </div>
                      {/* Deflation 拆解子項 */}
                      {r.cat === 'Deflation' && (
                        <div className="aw-sub">
                          <div className="aw-sub-row">
                            <span className="sl">└ TLT 公債</span>
                            <span className="sv num">{fmtNT(c.deflTLT)} · <span className="d">{fmtPct(c.tltPctOfDefl)}</span> Defl <span style={{ color: '#bbb' }}>(目標30–50%)</span></span>
                          </div>
                          <div className="aw-sub-row">
                            <span className="sl">└ 可動用現金</span>
                            <span className="sv num">{fmtNT(c.deflCash)} · <span className="d">{fmtPct(c.cashPctOfDefl)}</span> Defl <span style={{ color: '#bbb' }}>(目標50–70%)</span></span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {c.tltPctOfDefl < 0.3 && c.deflTLT > 0 && (
                <div className="note"><b>Deflation 拆解：</b>公債 {fmtPct(c.tltPctOfDefl)}（低於 30% 下限），現金 {fmtPct(c.cashPctOfDefl)}（高於上限）。下次戰略部署可優先補 TLT 拉到中位 40%。</div>
              )}
            </div>

            {/* ═══ 細部 ═══ */}
            <div className="layer"><span className="lt">Detail · 細部</span></div>

            <div className="g3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 14 }}>
              {[
                { lbl: '可投資基礎', val: fmtNT(c.base), sub: 'Cash + Invest' },
                { lbl: '月被動收益', val: fmtNT(c.monthly), sub: '利息＋股息（估）' },
                { lbl: '年化收益率', val: fmtPct(c.annYield), sub: '被動 / 基礎' },
              ].map((k, i) => (
                <div key={i} className="card card-hover" style={{ padding: 18 }}>
                  <div className="lbl" style={{ marginBottom: 8 }}>{k.lbl}</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 700 }}>{k.val}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 5 }}>{k.sub}</div>
                </div>
              ))}
            </div>

            <div className="g2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="card card-hover">
                <div className="lbl">台美資產分布</div>
                {[
                  { lbl: '台幣資產', val: c.twdTotal, pct: c.twdPct, color: '#2563eb' },
                  { lbl: '美元資產', val: c.usdTotal, pct: c.usdPct, color: '#d97706' },
                ].map((r, i) => (
                  <div key={i} style={{ marginBottom: i === 0 ? 13 : 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{r.lbl}</span>
                      <span className="num" style={{ fontSize: 13, color: '#555' }}>{fmtPct(r.pct)}</span>
                    </div>
                    <div className="bar"><div className="bf" style={{ width: mounted ? `${r.pct * 100}%` : '0%', background: r.color, opacity: .65 }} /></div>
                    <div className="num" style={{ fontSize: 12, color: '#777', marginTop: 4, textAlign: 'right' }}>{fmtTWD(r.val)}</div>
                  </div>
                ))}
              </div>

              {(c.monthSalary > 0 || c.monthBonus > 0 || c.monthDividend > 0 || c.monthOther > 0 || c.monthBuyAmt > 0) ? (
                <div className="card card-hover">
                  <div className="lbl">本月資金流入</div>
                  <div className="g4" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
                    {[
                      { lbl: '薪資', v: c.monthSalary, gold: false },
                      { lbl: '獎金', v: c.monthBonus, gold: false },
                      { lbl: '股息實收', v: c.monthDividend, gold: false },
                      { lbl: '本月買入', v: c.monthBuyAmt, gold: true },
                    ].map((r, i) => (
                      <div key={i}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{r.lbl}</div>
                        <div className="num" style={{ fontSize: 15, fontWeight: 700, color: r.v > 0 ? (r.gold ? '#d97706' : '#1a1a1a') : '#ccc' }}>
                          {r.v > 0 ? (r.gold ? `−${fmtNT(r.v)}` : fmtNT(r.v)) : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#aaa', marginTop: 10 }}>單位 NT$</div>
                </div>
              ) : (
                <div className="card card-hover">
                  <div className="lbl">被動收益（估算）</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {[{ lbl: '利息/yr', v: c.annInt }, { lbl: '股息/yr（估）', v: c.annDiv }].map((r, i) => (
                      <div key={i}>
                        <div style={{ fontSize: 12, color: '#777', marginBottom: 3 }}>{r.lbl}</div>
                        <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{fmtNT(r.v)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ fontSize: 10, color: '#ccc', textAlign: 'right', marginTop: 14 }}>股價來源：Google Sheets GOOGLEFINANCE · 約 15-20 分鐘更新</div>
          </div>
        )}

        {/* ══════════ POSITIONS ══════════ */}
        {tab === 'positions' && (
          <div className="fu card card-hover">
            <div className="lbl">持倉明細 <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#bbb' }}>· 金額單位 NT$</span></div>
            <div className="ptable-header" style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 84px 60px', gap: 8, paddingBottom: 11, borderBottom: '1px solid var(--line)' }}>
              {['Ticker', '名稱 / 詳情', '市值', '損益', '報酬%'].map((h, idx) => (
                <div key={h} style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', textAlign: idx >= 2 ? 'right' : 'left' }}>{h}</div>
              ))}
            </div>
            {c.positions.map((p, i) => (
              <div key={i} className="ptable row-hover" style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px 84px 60px', gap: 8, alignItems: 'center', padding: '14px 4px', borderBottom: '1px solid var(--line-soft)' }}>
                <div className="pos-ticker">
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{p.ticker}</div>
                  <div style={{ fontSize: 11, color: CAT_COLOR[p.category], marginTop: 2, fontWeight: 700 }}>{p.category}</div>
                </div>
                <div className="pos-name">
                  <div style={{ fontSize: 14, color: '#222', fontWeight: 500 }}>{p.name}</div>
                  <div className="pos-name-sub num" style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {p.sh.toLocaleString()} 股 · 均 {fmtNum(p.avgCost)} {p.currency}
                    {p.cp > 0 && <span> · 現 {fmtNum(p.cp)}</span>}
                    <span style={{ color: '#ccc' }}> · {fmtPct(p.portPct)}</span>
                  </div>
                </div>
                <div className="pos-detail num" style={{ fontSize: 12, color: '#888', marginTop: 1 }}>
                  {p.sh.toLocaleString()} 股 · 均 {fmtNum(p.avgCost)} {p.currency}
                  {p.cp > 0 && <span> · 現 {fmtNum(p.cp)}</span>}
                </div>
                <div className="pos-mv num" style={{ fontSize: 14, fontWeight: 700, textAlign: 'right' }}>{fmtNT(p.mvTWD)}</div>
                <div className="pos-pnl num" style={{ fontSize: 14, fontWeight: 700, textAlign: 'right', color: p.pnlTWD >= 0 ? '#16a34a' : '#dc2626' }}>
                  {p.pnlTWD >= 0 ? '+' : ''}{fmtNT(p.pnlTWD)}
                </div>
                <div className="pos-ret num" style={{ fontSize: 14, textAlign: 'right', color: p.ret >= 0 ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                  {p.ret >= 0 ? '+' : ''}{fmtPct(p.ret)}
                </div>
                <div style={{ gridColumn: '1 / -1', paddingTop: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: '#bbb' }}>配置比重</span>
                    <span className="num" style={{ fontSize: 10, color: '#bbb' }}>{fmtPct(p.portPct)}</span>
                  </div>
                  <div style={{ background: '#e8e4de', height: 3, borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 2, background: CAT_COLOR[p.category] || '#1a1a1a', opacity: 0.55, width: mounted ? `${p.portPct * 100}%` : '0%', transition: 'width 1s cubic-bezier(.4,0,.2,1)' }} />
                  </div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 14, borderTop: '1px solid var(--line)', marginTop: 4 }}>
              <span style={{ fontSize: 14, color: '#555', fontWeight: 600 }}>總投資市值</span>
              <span className="num" style={{ fontSize: 17, fontWeight: 700 }}>{fmtTWD(c.totInv)}</span>
            </div>
          </div>
        )}

        {/* ══════════ REBALANCE ══════════ */}
        {tab === 'rebalance' && (
          <div className="fu" style={{ display: 'grid', gap: 14 }}>
            <div className="card card-hover">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span className="step-tag" style={{ background: '#1a1a1a', color: '#fff' }}>Step 1</span>
                <div className="lbl" style={{ marginBottom: 0 }}>月定投計劃（{fmtTWD(c.fixedDCA)}）</div>
                <span style={{ fontSize: 12, color: '#999' }}>固定執行</span>
              </div>
              {c.dcaPlan.map((d, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: i < c.dcaPlan.length - 1 ? '1px solid var(--line-soft)' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="bdg buy">DCA</span>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>{d.ticker}</div>
                      <div style={{ fontSize: 13, color: '#666', marginTop: 2 }}>
                        {d.name} · <strong style={{ color: '#1a1a1a' }}>{d.shares} 股</strong> · 預算 {fmtTWD(d.budget)}
                        {d.cp > 0 && <span style={{ color: '#999', marginLeft: 5 }}>· 現價 {fmtNum(d.cp, 0)}</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="num" style={{ fontSize: 15, fontWeight: 700 }}>{fmtTWD(d.amt)}</div>
                    <div className="num" style={{ fontSize: 12, color: '#bbb', marginTop: 2 }}>殘差 {fmtTWD(d.residual)}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card card-hover">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span className="step-tag" style={{ background: '#374151', color: '#fff' }}>Step 2</span>
                <div className="lbl" style={{ marginBottom: 0 }}>All Weather 缺口</div>
                <span style={{ fontSize: 12, color: '#999' }}>彈性執行</span>
              </div>
              <div style={{ fontSize: 13, color: '#777', marginBottom: 14 }}>可動用現金 {fmtTWD(c.avail)} · 象限：{c.quadrant}</div>
              {c.awRows.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: i < c.awRows.length - 1 ? '1px solid var(--line-soft)' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: CAT_COLOR[r.cat] }} />
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{r.cat}</div>
                      <div className="num" style={{ fontSize: 12, color: '#777', marginTop: 2 }}>{fmtPct(r.cur)} → {fmtPct(r.tgt)}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`bdg ${r.gap > 0.01 ? 'buy' : r.gap < -0.01 ? 'over' : 'ok'}`}>
                      {r.gap > 0.01 ? '補' : r.gap < -0.01 ? '超' : 'OK'}
                    </span>
                    <div className="num" style={{ fontSize: 15, fontWeight: 700, marginTop: 4, color: r.gap > 0 ? '#16a34a' : '#dc2626' }}>
                      {r.gap > 0 ? '+' : ''}{fmtTWD(r.gapAmt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card card-hover">
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
                  return <div style={{ fontSize: 14, color: '#bbb', padding: '8px 0' }}>目前無明顯缺口需要補足</div>;
                return suggestions.map(({ p, sh, amt }, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="bdg buy">BUY</span>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700 }}>{p.ticker}</div>
                        <div style={{ fontSize: 13, color: '#666', marginTop: 2 }}>
                          {p.name} · <strong style={{ color: '#1a1a1a' }}>{sh} 股</strong> · {p.currency === 'USD' ? `$${fmtNum(p.cp)} USD` : `NT$ ${fmtNum(p.cp, 0)}`}
                        </div>
                      </div>
                    </div>
                    <div className="num" style={{ fontSize: 15, fontWeight: 700, color: '#16a34a' }}>{fmtTWD(amt)}</div>
                  </div>
                ));
              })()}
            </div>

            {c.nwHistory.length >= 2 && (
              <div className="card card-hover" style={{ padding: '14px 18px' }}>
                <LineChart data={c.nwHistory} />
              </div>
            )}
          </div>
        )}

        {/* ══════════ SIMULATE ══════════ */}
        {tab === 'simulate' && (
          <div className="fu" style={{ display: 'grid', gap: 14 }}>
            <div className="card card-hover">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div className="lbl" style={{ marginBottom: 0 }}>多標的加倉模擬</div>
                <button className="bp" onClick={() => setSimRows(r => [...r, {
                  mode: 'list', ticker: c.tickers[0] ? String(c.tickers[0].ticker) : '',
                  shares: 10, customTicker: '', customPrice: 0, customCurrency: 'USD'
                }])}>＋ 新增</button>
              </div>
              <div style={{ background: '#faf9f7', border: '1px solid var(--line)', borderRadius: 3, padding: '10px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 6 }}>All Weather 缺口參考</div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {c.awRows.filter(r => r.gap > 0.01).map((r, i) => (
                    <div key={i} style={{ fontSize: 13 }}>
                      <span style={{ color: CAT_COLOR[r.cat], fontWeight: 700 }}>{r.cat}</span>
                      <span style={{ color: '#777', marginLeft: 4 }}>缺 {fmtTWD(r.gapAmt)}</span>
                    </div>
                  ))}
                </div>
              </div>
              {simRows.map((row, i) => (
                <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '12px 14px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    {(['list', 'custom'] as const).map(m => (
                      <button key={m} onClick={() => setSimRows(r => r.map((x, j) => j === i ? { ...x, mode: m } : x))}
                        style={{ fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 2, cursor: 'pointer', border: '1.5px solid', borderColor: row.mode === m ? '#1a1a1a' : 'var(--line)', background: row.mode === m ? '#1a1a1a' : 'transparent', color: row.mode === m ? '#fff' : '#888', fontFamily: "'DM Sans',system-ui" }}>
                        {m === 'list' ? '從清單選' : '手動輸入'}
                      </button>
                    ))}
                  </div>
                  {row.mode === 'list' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 40px', gap: 8, alignItems: 'center' }}>
                      <select className="inp" value={row.ticker} onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, ticker: e.target.value } : x))}>
                        {c.tickers.map(t => <option key={t.ticker} value={String(t.ticker)}>{t.ticker} · {t.name}</option>)}
                      </select>
                      <input type="number" className="inp" value={row.shares} min={0} placeholder="股數" onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, shares: Number(e.target.value) } : x))} />
                      <button className="bd-r" onClick={() => setSimRows(r => r.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 75px 90px 110px 40px', gap: 8, alignItems: 'center' }}>
                      <input className="inp" placeholder="Ticker（如 TLT）" value={row.customTicker} onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, customTicker: e.target.value.toUpperCase() } : x))} />
                      <select className="inp" value={row.customCurrency} onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, customCurrency: e.target.value } : x))}>
                        <option value="TWD">TWD</option>
                        <option value="USD">USD</option>
                      </select>
                      <input type="number" className="inp" placeholder="模擬價格" value={row.customPrice || ''} min={0} onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, customPrice: Number(e.target.value) } : x))} />
                      <input type="number" className="inp" placeholder="股數" value={row.shares} min={0} onChange={e => setSimRows(r => r.map((x, j) => j === i ? { ...x, shares: Number(e.target.value) } : x))} />
                      <button className="bd-r" onClick={() => setSimRows(r => r.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {simResults.length > 0 && (
              <div className="card card-hover">
                <div className="lbl">模擬結果</div>
                {simResults.map((r, i) => (
                  <div key={i} style={{ background: '#faf9f7', border: '1px solid var(--line)', borderRadius: 3, padding: 15, marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
                      <div>
                        <span style={{ fontSize: 15, fontWeight: 700 }}>{r.ticker}</span>
                        <span style={{ fontSize: 13, color: '#777', marginLeft: 8 }}>{r.name} · 買入 {r.qty} 股</span>
                        {r.origSh === 0 && <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 6, padding: '2px 6px', background: '#f0f9ff', color: '#0284c7', borderRadius: 2, border: '1px solid #bae6fd' }}>NEW</span>}
                      </div>
                      <div className="num" style={{ fontSize: 15, fontWeight: 700, color: '#16a34a' }}>{fmtTWD(r.buyAmt)}</div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
                      {[
                        { lbl: '新均成本', b: r.origSh > 0 ? `${fmtNum(r.origAvg)} ${r.currency}` : '—', a: `${fmtNum(r.nAvg)} ${r.currency}` },
                        { lbl: '持股數',   b: `${r.origSh} 股`, a: `${r.nSh} 股` },
                        { lbl: '未實現損益', b: r.origSh > 0 ? `${r.origPnL >= 0 ? '+' : ''}${fmtNT(r.origPnL)}` : '—', a: `${r.nPnL >= 0 ? '+' : ''}${fmtNT(r.nPnL)}` },
                        { lbl: '報酬率',   b: r.origSh > 0 ? `${r.origRet >= 0 ? '+' : ''}${fmtPct(r.origRet)}` : '—', a: `${r.nRet >= 0 ? '+' : ''}${fmtPct(r.nRet)}` },
                      ].map((cc, j) => (
                        <div key={j}>
                          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 4 }}>{cc.lbl}</div>
                          <div className="num" style={{ fontSize: 11, color: '#bbb', textDecoration: 'line-through', marginBottom: 2 }}>{cc.b}</div>
                          <div className="num" style={{ fontSize: 14, fontWeight: 700 }}>{cc.a}</div>
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
                    <div key={i} style={{ marginBottom: i < 2 ? 14 : 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <div style={{ width: 7, height: 7, borderRadius: '50%', background: CAT_COLOR[cat] }} />
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{cat}</span>
                        </div>
                        <span className="num" style={{ fontSize: 13 }}>
                          <span style={{ color: '#777' }}>{fmtPct(bef)}</span>
                          <span style={{ color: '#ccc', margin: '0 5px' }}>→</span>
                          <span style={{ fontWeight: 700, color: CAT_COLOR[cat] }}>{fmtPct(aft)}</span>
                          <span style={{ color: '#bbb' }}> / {fmtPct(tgt)}</span>
                        </span>
                      </div>
                      <div className="bar"><div className="bf" style={{ width: `${Math.min(aft / tgt, 1) * 100}%`, background: CAT_COLOR[cat], opacity: .65 }} /></div>
                    </div>
                  );
                })}
                <div className="hr" />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#777', marginBottom: 3 }}>模擬總投入</div>
                    <div className="num" style={{ fontSize: 19, fontWeight: 700 }}>{fmtTWD(simTotal)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, color: '#777', marginBottom: 3 }}>執行後可動用現金</div>
                    <div className="num" style={{ fontSize: 19, fontWeight: 700, color: c.avail - simTotal < 0 ? '#dc2626' : '#1a1a1a' }}>{fmtTWD(c.avail - simTotal)}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════════ REALIZED ══════════ */}
        {tab === 'realized' && (
          <div className="fu" style={{ display: 'grid', gap: 14 }}>
            <div className="card card-hover">
              <div className="lbl">整體績效摘要（憲法 8.1）</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>已實現損益合計</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 700, color: c.realizedTotalPnL >= 0 ? '#16a34a' : '#dc2626' }}>
                    {c.realizedTotalPnL >= 0 ? '+' : ''}{fmtNT(c.realizedTotalPnL)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>已實現平均年化</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 700, color: c.realizedAvgAnnReturn && c.realizedAvgAnnReturn >= 0 ? '#16a34a' : '#dc2626' }}>
                    {c.realizedAvgAnnReturn !== null ? `${c.realizedAvgAnnReturn >= 0 ? '+' : ''}${fmtPct(c.realizedAvgAnnReturn)}` : '—'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>基準（{c.benchmarkName}）年報酬</div>
                  <div className="num" style={{ fontSize: 18, fontWeight: 700, color: '#555' }}>
                    {c.benchmarkAnnRet > 0 ? `${fmtPct(c.benchmarkAnnRet)}` : <span style={{ fontSize: 13, color: '#bbb' }}>未填入</span>}
                  </div>
                </div>
              </div>
              {c.benchmarkAnnRet > 0 && c.realizedAvgAnnReturn !== null && (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
                  <div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>超額報酬（已實現年化 − 基準）</div>
                  <div className="num" style={{ fontSize: 20, fontWeight: 700, color: (c.realizedAvgAnnReturn - c.benchmarkAnnRet) >= 0 ? '#16a34a' : '#dc2626' }}>
                    {(c.realizedAvgAnnReturn - c.benchmarkAnnRet) >= 0 ? '+' : ''}{fmtPct(c.realizedAvgAnnReturn - c.benchmarkAnnRet)}
                  </div>
                  <div style={{ fontSize: 11, color: '#999', marginTop: 3 }}>
                    {(c.realizedAvgAnnReturn - c.benchmarkAnnRet) >= 0 ? '✓ 跑贏基準' : '✗ 跑輸基準，建議檢視配置'}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: '#bbb', marginTop: 10 }}>＊基準年報酬率請每年底手動填入 Settings 區塊三</div>
            </div>

            <div className="card card-hover">
              <div className="lbl">已實現明細 <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#bbb' }}>· 金額單位 NT$</span></div>
              {c.realizedRows.length === 0
                ? <div style={{ fontSize: 15, color: '#999', padding: '16px 0' }}>尚無已出場紀錄</div>
                : c.realizedRows.map((r, i) => (
                  <div key={i} className="row-hover" style={{ padding: '18px 4px', borderBottom: i < c.realizedRows.length - 1 ? '1px solid var(--line-soft)' : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 700 }}>{String(r.ticker)} · {String(r.instrument)}</div>
                        <div style={{ fontSize: 12, color: '#999', marginTop: 3 }}>持有 {r.holdingDays} 天</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div className="num" style={{ fontSize: 17, fontWeight: 700, color: r.pnlTWD >= 0 ? '#16a34a' : '#dc2626' }}>
                          {r.pnlTWD >= 0 ? '+' : ''}{fmtNT(r.pnlTWD)}
                        </div>
                        <div className="num" style={{ fontSize: 13, color: '#888', marginTop: 2 }}>報酬率 {fmtPct(r.returnPct)}</div>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
                      {[
                        { lbl: '買入成本', v: fmtNT(r.buyCost) },
                        { lbl: '賣出金額', v: fmtNT(r.sellValue) },
                        { lbl: '年化報酬', v: fmtPct(r.annReturn) },
                        { lbl: '年化 Alpha', v: fmtPct(r.annAlpha) },
                      ].map((cc, j) => (
                        <div key={j}>
                          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 4 }}>{cc.lbl}</div>
                          <div className="num" style={{ fontSize: 14, fontWeight: 600 }}>{cc.v}</div>
                        </div>
                      ))}
                    </div>
                    {r.notes && <div style={{ fontSize: 13, color: '#888', marginTop: 10, fontStyle: 'italic' }}>「{r.notes}」</div>}
                  </div>
                ))
              }
            </div>
          </div>
        )}

      </div>

      <nav className="bottom-nav" style={{ display: 'none' }}>
        {TABS.map(([k, v]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => handleTab(k)}>
            <div className="nav-dot" />
            {v}
          </button>
        ))}
      </nav>

    </div>
  );
}