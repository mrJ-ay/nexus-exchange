/* =========================================================
   NEXUS EXCHANGE (넥서스 증권거래소) — 프론트엔드 엔진
   - 실시간 캔들스틱 차트, 호가창, 원클릭 매매, IPO 상장
   ========================================================= */

const AUTH_KEY = 'NEXUS_TOKEN';
const PKCE_KEY = 'nx_pkce';
const redirectUri = () => location.origin + '/';
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let token = localStorage.getItem(AUTH_KEY);
let CFG = null;
let user = null;
let balance = 0;

let stocks = [];
let selectedStockId = null;
let selectedStock = null;
let candleHistory = [];
let portfolio = [];
let currentFilter = 'all';
let currentTradeTab = 'buy'; // 'buy' or 'sell'

const $ = id => document.getElementById(id);

// ---------- API 헬퍼 ----------
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let body = options.body;
  if (body && typeof body === 'object') body = JSON.stringify(body);

  const res = await fetch(path, { ...options, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || '요청 처리에 실패했습니다.');
  }
  return data;
}

function won(num) {
  return '$' + Math.round(Number(num) || 0).toLocaleString('en-US');
}

function toast(msg, type = 'success') {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '⚡' : '⚠️'}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ---------- 초기 구동 ----------
window.addEventListener('DOMContentLoaded', async () => {
  setupEvents();
  initCanvas();

  try {
    CFG = await api('/api/config');

    // 1. ONEID OAuth PKCE 콜백 처리
    try {
      await handleOauthCallback();
    } catch (authErr) {
      console.warn('OAuth callback failed:', authErr);
      toast(authErr.message || 'ONEID 로그인 검증 실패', 'error');
    }

    // 2. 유저 상태 및 마켓 데이터 로드
    await loadUserState();
    await reloadStocks(true);
    await reloadNews();

    // 1초 주기 실시간 시장 시세 및 차트 갱신 (초고속 반응)
    setInterval(async () => {
      await reloadStocks(false);
      if (token) await loadUserState(false);
    }, 1000);

    // 15초 주기 뉴스 갱신
    setInterval(reloadNews, 15000);
  } catch (err) {
    console.error('[Init Error]', err);
  }
});

// ---------- 유저 상태 및 포트폴리오 로드 ----------
async function loadUserState(showToast = false) {
  if (!token) {
    $('myBalanceDisplay').textContent = '$0';
    $('authBtn').textContent = '로그인';
    $('portfolioTableBody').innerHTML = '<tr><td colspan="8" class="empty-cell">로그인이 필요합니다. 상단 [로그인] 버튼을 눌러주세요.</td></tr>';
    $('portfolioCount').textContent = '0';
    return;
  }

  try {
    const data = await api('/api/me');
    user = data.user;
    balance = data.balance || 0;
    portfolio = data.portfolio || [];

    $('myBalanceDisplay').textContent = won(balance);
    $('authBtn').textContent = `${user.name} (로그아웃)`;
    $('portfolioCount').textContent = portfolio.length;

    renderPortfolio(data.summary);
    updateTradeCalc();
  } catch (err) {
    // 만료된 토큰인 경우
    token = null;
    localStorage.removeItem(AUTH_KEY);
    loadUserState();
  }
}

// ---------- 포트폴리오 렌더링 ----------
function renderPortfolio(summary) {
  $('sumInvested').textContent = won(summary?.totalInvested || 0);
  $('sumEval').textContent = won(summary?.totalEvaluation || 0);

  const profit = summary?.totalProfit || 0;
  const rate = summary?.profitRate || 0;
  const pClass = profit > 0 ? 'up' : (profit < 0 ? 'down' : 'neutral');
  const sign = profit > 0 ? '+' : '';
  $('sumProfit').className = pClass;
  $('sumProfit').textContent = `${sign}${won(profit)} (${sign}${rate.toFixed(2)}%)`;

  const tbody = $('portfolioTableBody');
  if (!portfolio.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">보유 중인 주식이 없습니다. 좌측에서 종목을 선택해 투자해 보세요!</td></tr>';
    return;
  }

  tbody.innerHTML = portfolio.map(h => {
    const pAmt = Number(h.profit_amount || 0);
    const pRate = Number(h.profit_rate || 0);
    const cls = pAmt > 0 ? 'up' : (pAmt < 0 ? 'down' : 'neutral');
    const sSign = pAmt > 0 ? '+' : '';

    return `
      <tr>
        <td>
          <span style="font-size:1.1rem;margin-right:4px;">${h.icon}</span>
          <b>${h.name}</b>
          ${h.is_founder ? '<span class="stock-founder-badge" style="margin-left:4px;">대표</span>' : ''}
          <div style="font-size:0.68rem;color:var(--text-dim);font-family:var(--font-mono);">${h.ticker}</div>
        </td>
        <td><b>${Number(h.shares).toLocaleString()}</b>주</td>
        <td>${won(h.avg_buy_price)}</td>
        <td>${won(h.current_price)}</td>
        <td style="font-weight:700;">${won(h.current_eval)}</td>
        <td class="${cls}">${sSign}${won(pAmt)}</td>
        <td class="${cls}">${sSign}${pRate.toFixed(2)}%</td>
        <td>
          <button class="btn-sell-fast" onclick="selectStock(${h.stock_id}); switchTradeTab('sell'); $('orderSharesInput').value = ${h.shares}; updateTradeCalc();">전량 매도</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ---------- 주식 목록 로드 및 렌더링 ----------
async function reloadStocks(isFirst = false) {
  try {
    const res = await api('/api/stocks');
    stocks = res.stocks || [];

    if (!stocks.length) return;

    // 첫 로드이거나 선택된 종목이 없으면 1호 종목 선택
    if (isFirst || !selectedStockId) {
      selectedStockId = stocks[0].id;
    }

    renderStockList();
    renderTickerBar();

    // 현재 선택된 종목 정보 갱신
    const current = stocks.find(s => s.id === selectedStockId) || stocks[0];
    selectedStock = current;
    renderSelectedStockHeader(current);
    renderOrderBook(current);

    // 차트 데이터 로드
    if (isFirst) {
      await loadStockDetail(selectedStockId);
    } else {
      // 실시간 가격 변동 반영하여 마지막 캔들만 갱신
      updateCurrentCandle(current.current_price);
    }
  } catch (err) {
    console.error('[Reload Stocks Error]', err);
  }
}

// ---------- 종목 상세 (히스토리 차트) 로드 ----------
async function loadStockDetail(stockId) {
  try {
    const res = await api(`/api/stocks/${stockId}`);
    if (res.stock) {
      selectedStock = res.stock;
      candleHistory = res.history || [];
      renderSelectedStockHeader(res.stock);
      renderOrderBook(res.stock);
      drawCandleChart();
      updateTradeCalc();
    }
  } catch (err) {
    console.error('[Load Stock Detail Error]', err);
  }
}

function selectStock(stockId) {
  selectedStockId = Number(stockId);
  renderStockList();
  loadStockDetail(selectedStockId);
}
window.selectStock = selectStock;

// ---------- 종목 리스트 렌더링 ----------
function renderStockList() {
  const container = $('stockList');
  const search = $('stockSearchInput').value.trim().toLowerCase();

  let filtered = stocks.filter(s => {
    if (search) {
      const matchName = s.name.toLowerCase().includes(search);
      const matchTicker = s.ticker.toLowerCase().includes(search);
      if (!matchName && !matchTicker) return false;
    }
    if (currentFilter === 'crypto') return s.is_crypto || s.ticker === 'NBTC';
    if (currentFilter === 'user') return !s.is_system;
    if (currentFilter === 'mine') return portfolio.some(h => h.stock_id === s.id);
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-dim);font-size:0.75rem;">해당 조건의 종목이 없습니다.</div>';
    return;
  }

  container.innerHTML = filtered.map(s => {
    const isSelected = s.id === selectedStockId;
    const diff = Number(s.change_amount || 0);
    const rate = Number(s.change_rate || 0);
    const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'neutral');
    const sign = diff > 0 ? '+' : '';
    const isCrypto = Boolean(s.is_crypto || s.ticker === 'NBTC');

    return `
      <div class="stock-row ${isSelected ? 'selected' : ''}" onclick="selectStock(${s.id})">
        <div class="row-name-wrap">
          <span class="row-icon">${s.icon}</span>
          <div class="row-name-box">
            <span class="row-title">${s.name}</span>
            <span class="row-ticker">
              ${s.ticker}${s.creator_name && !s.is_system ? ` · ${s.creator_name}` : ''}
              ${isCrypto ? '<span class="badge-crypto-pulse">⚡ 1초 틱</span>' : ''}
            </span>
          </div>
        </div>
        <div class="row-price ${cls}">${won(s.current_price)}</div>
        <div class="row-change ${cls}">${sign}${rate.toFixed(2)}%</div>
      </div>
    `;
  }).join('');
}

// ---------- 선택된 종목 헤더 정보 렌더링 ----------
function renderSelectedStockHeader(s) {
  if (!s) return;
  $('viewStockIcon').textContent = s.icon;
  $('viewStockName').textContent = s.name;
  $('viewStockTicker').textContent = s.ticker;

  if (s.is_crypto || s.ticker === 'NBTC') {
    $('viewStockFounder').className = 'stock-founder-badge crypto-badge';
    $('viewStockFounder').textContent = '🔥 1초 쾌속 틱 · 초고변동 암호화폐 (±8%)';
  } else if (s.is_system) {
    $('viewStockFounder').className = 'stock-founder-badge';
    $('viewStockFounder').textContent = '시스템 대장주';
  } else {
    $('viewStockFounder').className = 'stock-founder-badge';
    $('viewStockFounder').textContent = `👑 창업: ${s.creator_name || '익명'}`;
  }

  $('viewStockDesc').textContent = s.description || 'NEXUS 거래소 상장 주식회사';

  const diff = Number(s.change_amount || 0);
  const rate = Number(s.change_rate || 0);
  const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'neutral');
  const sign = diff > 0 ? '+' : '';

  $('viewStockPrice').className = `price-large ${cls}`;
  $('viewStockPrice').textContent = won(s.current_price);

  $('viewChangeAmount').className = `change-amount ${cls}`;
  $('viewChangeAmount').textContent = `${diff >= 0 ? '▲ +' : '▼ -'}${won(Math.abs(diff))}`;

  $('viewChangeRate').className = `change-rate ${cls}`;
  $('viewChangeRate').textContent = `(${sign}${rate.toFixed(2)}%)`;

  $('viewHighPrice').textContent = won(s.high_price);
  $('viewLowPrice').textContent = won(s.low_price);
  $('viewVolume').textContent = Number(s.volume_24h).toLocaleString() + '주';
  $('viewTotalShares').textContent = Number(s.total_shares).toLocaleString() + '주';

  $('orderPriceDisplay').textContent = won(s.current_price);
}

// ---------- 최상단 마퀴 티커 렌더링 ----------
function renderTickerBar() {
  const track = $('tickerTrack');
  if (!stocks.length) return;

  const html = stocks.map(s => {
    const diff = Number(s.change_amount || 0);
    const rate = Number(s.change_rate || 0);
    const cls = diff > 0 ? 'up' : (diff < 0 ? 'down' : 'neutral');
    const sign = diff > 0 ? '▲ +' : (diff < 0 ? '▼ -' : '');
    return `
      <span class="ticker-item ${cls}" onclick="selectStock(${s.id})">
        <span>${s.icon} ${s.ticker}</span>
        <strong>${won(s.current_price)}</strong>
        <span>(${sign}${rate.toFixed(1)}%)</span>
      </span>
    `;
  }).join(' · ');

  track.innerHTML = html + ' · ' + html; // 무한 스크롤용 복제
}

// ---------- 실시간 호가창 렌더링 (10단계 오더북) ----------
function renderOrderBook(stock) {
  if (!stock) return;
  const p = stock.current_price;
  const asksEl = $('orderbookAsks');
  const bidsEl = $('orderbookBids');

  $('obCurrentPrice').textContent = won(p);
  const diff = Number(stock.change_amount || 0);
  const rate = Number(stock.change_rate || 0);
  $('obCurrentPrice').className = `ob-price ${diff >= 0 ? 'up' : 'down'}`;
  $('obCurrentRate').className = `ob-rate ${diff >= 0 ? 'up' : 'down'}`;
  $('obCurrentRate').textContent = `${diff >= 0 ? '+' : ''}${rate.toFixed(2)}%`;

  // 5단계 매도 호가 (위에 위치, 비싼 가격)
  let asksHtml = '';
  for (let i = 5; i >= 1; i--) {
    const stepPrice = Math.round(p * (1 + i * 0.005));
    const vol = Math.round((Math.sin(p + i) * 1000 + 1500) * (6 - i));
    const depthPct = Math.min(100, Math.round((vol / 8000) * 100));
    asksHtml += `
      <div class="orderbook-row ask" onclick="$('orderPriceDisplay').textContent = '${won(stepPrice)}';">
        <span class="ob-p">${won(stepPrice)}</span>
        <span class="ob-v">${vol.toLocaleString()}</span>
        <div class="ob-depth-bar ask" style="width:${depthPct}%;"></div>
      </div>
    `;
  }
  asksEl.innerHTML = asksHtml;

  // 5단계 매수 호가 (아래에 위치, 싼 가격)
  let bidsHtml = '';
  for (let i = 1; i <= 5; i++) {
    const stepPrice = Math.max(10, Math.round(p * (1 - i * 0.005)));
    const vol = Math.round((Math.cos(p + i) * 1000 + 1500) * (6 - i));
    const depthPct = Math.min(100, Math.round((vol / 8000) * 100));
    bidsHtml += `
      <div class="orderbook-row bid" onclick="$('orderPriceDisplay').textContent = '${won(stepPrice)}';">
        <span class="ob-p">${won(stepPrice)}</span>
        <span class="ob-v">${vol.toLocaleString()}</span>
        <div class="ob-depth-bar bid" style="width:${depthPct}%;"></div>
      </div>
    `;
  }
  bidsEl.innerHTML = bidsHtml;
}

// ---------- 실시간 캔들스틱 차트 엔진 (HTML5 Canvas) ----------
let canvas, ctx;
let chartWidth = 800, chartHeight = 380;
let crosshair = null; // { x, y }

function initCanvas() {
  canvas = $('candleChart');
  ctx = canvas.getContext('2d');

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    chartWidth = rect.width;
    chartHeight = rect.height;
    canvas.width = chartWidth * dpr;
    canvas.height = chartHeight * dpr;
    ctx.scale(dpr, dpr);
    drawCandleChart();
  }

  window.addEventListener('resize', resize);
  setTimeout(resize, 100);

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    crosshair = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    drawCandleChart();
  });

  canvas.addEventListener('mouseleave', () => {
    crosshair = null;
    drawCandleChart();
  });
}

function updateCurrentCandle(currentPrice) {
  if (!candleHistory.length) return;
  const last = candleHistory[candleHistory.length - 1];
  last.close = currentPrice;
  last.high = Math.max(last.high, currentPrice);
  last.low = Math.min(last.low, currentPrice);
  drawCandleChart();
}

function drawCandleChart() {
  if (!ctx || !candleHistory || !candleHistory.length) return;

  const w = chartWidth;
  const h = chartHeight;
  ctx.clearRect(0, 0, w, h);

  // 차트 마진
  const paddingRight = 65;
  const paddingBottom = 40;
  const plotW = w - paddingRight;
  const plotH = h - paddingBottom;
  const volH = plotH * 0.22; // 볼륨 바 높이
  const mainH = plotH - volH;

  // 가격 최소/최대 계산
  let rawMin = Infinity;
  let rawMax = -Infinity;
  let maxVol = 1;

  const count = candleHistory.length;
  candleHistory.forEach(c => {
    if (c.low < rawMin) rawMin = c.low;
    if (c.high > rawMax) rawMax = c.high;
    if (c.volume > maxVol) maxVol = c.volume;
  });

  // 최소 수직 여유 공간(Headroom): 현재 주가의 최소 12% (상하 ±6%) 폭을 항상 보장
  // 가격이 1원/1틱만 올라도 화면 위아래로 꽉 차는 현상 완전 방지
  const curPrice = selectedStock?.current_price || ((rawMin + rawMax) / 2) || 1000;
  const minHeadroom = Math.max(20, Math.round(curPrice * 0.12));
  let priceDiff = rawMax - rawMin;

  let minPrice, maxPrice;
  if (priceDiff < minHeadroom) {
    const mid = (rawMax + rawMin) / 2;
    minPrice = Math.max(1, Math.round(mid - minHeadroom / 2));
    maxPrice = Math.round(mid + minHeadroom / 2);
  } else {
    const margin = Math.max(10, Math.round(priceDiff * 0.08));
    minPrice = Math.max(1, rawMin - margin);
    maxPrice = rawMax + margin;
  }
  const priceRange = maxPrice - minPrice || 1;

  // 1. 배경 그리드 및 Y축 가격 눈금선
  ctx.strokeStyle = '#1C2638';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748B';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'left';

  const gridSteps = 5;
  for (let i = 0; i <= gridSteps; i++) {
    const y = mainH * (i / gridSteps);
    const pVal = maxPrice - (priceRange * (i / gridSteps));

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
    ctx.stroke();

    ctx.fillText(won(pVal), plotW + 6, y + 4);
  }

  // 2. 캔들스틱 및 볼륨 바 그리기
  // 캔들이 적을 때 거대해지지 않도록 최대폭(18px)으로 캡하고 우측 정렬 (TradingView / 업비트 방식)
  const minCandlesScale = 35; // 기본 35개 기준 그리드 슬롯
  const candleGap = 3;
  const candleSlot = Math.min(18, Math.max(5, plotW / Math.max(count, minCandlesScale)));
  const candleWidth = Math.max(2, candleSlot - candleGap);

  // 차트 우측 정렬 (캔들이 적으면 우측부터 최신순으로 정렬)
  const totalChartW = count * candleSlot;
  const startX = Math.max(0, plotW - totalChartW);

  let hoveredCandle = null;

  candleHistory.forEach((c, idx) => {
    const x = startX + idx * candleSlot + candleWidth / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? '#EF4444' : '#3B82F6';

    // 볼륨 바
    const vBarH = (c.volume / (maxVol || 1)) * volH;
    const vY = plotH - vBarH;
    ctx.fillStyle = isUp ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)';
    ctx.fillRect(x - candleWidth / 2, vY, candleWidth, vBarH);

    // 캔들 심지 (Wick)
    const yHigh = mainH - ((c.high - minPrice) / priceRange) * mainH;
    const yLow = mainH - ((c.low - minPrice) / priceRange) * mainH;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    // 캔들 몸통 (Body)
    const yOpen = mainH - ((c.open - minPrice) / priceRange) * mainH;
    const yClose = mainH - ((c.close - minPrice) / priceRange) * mainH;
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));

    ctx.fillStyle = color;
    ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyH);

    // 마우스 호버 검출
    if (crosshair && Math.abs(crosshair.x - x) <= candleSlot / 2) {
      hoveredCandle = { ...c, x, yClose };
    }
  });

  // 3. 십자선(Crosshair) 및 툴팁
  if (crosshair && hoveredCandle) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    // 수직선
    ctx.beginPath();
    ctx.moveTo(hoveredCandle.x, 0);
    ctx.lineTo(hoveredCandle.x, plotH);
    ctx.stroke();

    // 수평선
    ctx.beginPath();
    ctx.moveTo(0, crosshair.y);
    ctx.lineTo(plotW, crosshair.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 현재 커서 위치 가격 태그
    const cursorPrice = maxPrice - (priceRange * (crosshair.y / mainH));
    ctx.fillStyle = '#222C42';
    ctx.fillRect(plotW + 2, crosshair.y - 9, 60, 18);
    ctx.fillStyle = '#00F0FF';
    ctx.fillText(won(cursorPrice), plotW + 6, crosshair.y + 4);

    // 툴팁 박스 (상단 좌측)
    ctx.fillStyle = 'rgba(18, 23, 34, 0.9)';
    ctx.strokeStyle = '#26334A';
    ctx.fillRect(10, 10, 260, 26);
    ctx.strokeRect(10, 10, 260, 26);

    ctx.fillStyle = '#F1F5F9';
    ctx.font = '10px JetBrains Mono, monospace';
    const isUp = hoveredCandle.close >= hoveredCandle.open;
    ctx.fillText(`시:${won(hoveredCandle.open)} 고:${won(hoveredCandle.high)} 저:${won(hoveredCandle.low)} 종:${won(hoveredCandle.close)}`, 16, 26);
  }
}

// ---------- 주문 박스 계산 및 탭 전환 ----------
function switchTradeTab(tab) {
  currentTradeTab = tab;
  $('tabBuy').classList.toggle('active', tab === 'buy');
  $('tabSell').classList.toggle('active', tab === 'sell');

  $('submitOrderBtn').className = `btn-submit-order ${tab}`;
  if (tab === 'buy') {
    $('submitOrderBtn').textContent = '매수하기 (풀매수)';
    $('calcLabel').textContent = '총 결제 금액';
  } else {
    $('submitOrderBtn').textContent = '매도하기 (전량 매도)';
    $('calcLabel').textContent = '예상 환전 금액';
  }
  updateTradeCalc();
}
window.switchTradeTab = switchTradeTab;

function updateTradeCalc() {
  if (!selectedStock) return;
  const p = selectedStock.current_price;
  const shares = Math.max(1, Number($('orderSharesInput').value) || 1);
  const total = shares * p;

  $('calcTotalAmount').textContent = won(total);

  if (currentTradeTab === 'buy') {
    const maxShares = Math.floor(balance / p);
    $('calcSubInfo').textContent = `주문 가능 잔고: ${won(balance)} (최대 ${maxShares.toLocaleString()}주)`;
  } else {
    const myH = portfolio.find(h => h.stock_id === selectedStock.id);
    const myShares = myH ? Number(myH.shares) : 0;
    $('calcSubInfo').textContent = `내 보유 수량: ${myShares.toLocaleString()}주 (매도 가능)`;
  }
}

// ---------- 주문 제출 (매수 / 매도) ----------
async function submitTradeOrder() {
  if (!token) {
    openLoginModal();
    return;
  }
  if (!selectedStock) return;

  const shares = Number($('orderSharesInput').value);
  if (!shares || shares <= 0) {
    alert('주문 수량을 올바르게 입력해주세요.');
    return;
  }

  const btn = $('submitOrderBtn');
  btn.disabled = true;
  btn.textContent = '주문 체결 중...';

  try {
    if (currentTradeTab === 'buy') {
      const res = await api('/api/stocks/buy', {
        method: 'POST',
        body: { stockId: selectedStock.id, shares }
      });
      toast(`🎉 [${res.stockName}] ${shares}주 매수 체결 완료! (-${won(res.totalCost)})`, 'success');
    } else {
      const res = await api('/api/stocks/sell', {
        method: 'POST',
        body: { stockId: selectedStock.id, shares }
      });
      let msg = `💰 [${res.stockName}] ${shares}주 매도 체결! (+${won(res.revenue)})`;
      if (res.insuranceRefund > 0) {
        msg += ` 🧻 [자켓 화장지 손절 보험] +${won(res.insuranceRefund)} 위로금 지급!`;
      }
      toast(msg, res.profitLoss >= 0 ? 'success' : 'error');
    }

    await loadUserState();
    await reloadStocks(false);
  } catch (err) {
    alert(err.message || '주문 실패');
  } finally {
    btn.disabled = false;
    btn.textContent = currentTradeTab === 'buy' ? '매수하기 (풀매수)' : '매도하기 (전량 매도)';
  }
}

// ---------- 신규 기업공개 (IPO) 신청 ----------
async function handleIpoSubmit() {
  if (!token) {
    openLoginModal();
    return;
  }

  const name = $('ipoName').value.trim();
  const ticker = $('ipoTicker').value.trim().toUpperCase();
  const icon = $('ipoIcon').value.trim() || '🚀';
  const initialPrice = Number($('ipoPrice').value);
  const totalShares = Number($('ipoShares').value);
  const description = $('ipoDesc').value.trim();

  if (!name || !ticker) {
    alert('회사명과 티커를 입력해주세요.');
    return;
  }

  const btn = $('submitIpoBtn');
  btn.disabled = true;
  btn.textContent = '거래소 상장 심사 중...';

  try {
    const res = await api('/api/stocks/ipo', {
      method: 'POST',
      body: { name, ticker, icon, description, initialPrice, totalShares }
    });

    closeIpoModal();
    toast(`🏛️ 축하합니다! [${res.stock.name}]이 상장되었습니다! 창업자 지분 30%(${res.founderShares.toLocaleString()}주) 입고 완료!`, 'success');

    await loadUserState();
    await reloadStocks(true);
    selectStock(res.stock.id);
  } catch (err) {
    alert(err.message || '상장 실패');
  } finally {
    btn.disabled = false;
    btn.textContent = '🏛️ 50만 칩 납부하고 거래소 상장하기';
  }
}

function updateIpoPreview() {
  const p = Number($('ipoPrice').value) || 0;
  const s = Number($('ipoShares').value) || 0;
  const cap = p * s;
  const founderShares = Math.floor(s * 0.3);
  const founderVal = founderShares * p;

  $('previewMarketCap').textContent = won(cap);
  $('previewFounderShares').textContent = `${founderShares.toLocaleString()}주 (${won(founderVal)} 상당)`;
}

// ---------- 증시 뉴스 피드 로드 ----------
async function reloadNews() {
  try {
    const res = await api('/api/news');
    const news = res.news || [];
    if (!news.length) return;

    // 상단 속보 바 갱신
    $('breakingNewsText').textContent = news[0].headline;

    // 하단 공시 탭 갱신
    $('newsFeedList').innerHTML = news.map(n => `
      <div class="news-feed-item">
        <span class="news-badge">공시</span>
        <span class="news-feed-time">${new Date(n.created_at).toLocaleTimeString()}</span>
        <span style="flex:1;">${n.headline}</span>
      </div>
    `).join('');
  } catch (e) {
    console.error(e);
  }
}

// ---------- 모달 제어 ----------
function openIpoModal() {
  if (!token) {
    openLoginModal();
    return;
  }
  updateIpoPreview();
  $('ipoBackdrop').classList.add('show');
}
function closeIpoModal() {
  $('ipoBackdrop').classList.remove('show');
}

function openLoginModal() {
  $('loginBackdrop').classList.add('show');
}
function closeLoginModal() {
  $('loginBackdrop').classList.remove('show');
}

// ---------- ONEID / 게스트 로그인 ----------
async function startOneidLogin() {
  if (!CFG) return;
  localStorage.removeItem(AUTH_KEY);

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));

  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));

  const oneid = CFG.oneidUrl || 'https://oneid-icvq.onrender.com';
  const loginUrl = `${oneid}/login.html?` + new URLSearchParams({
    client_id: CFG.clientId || 'nexus-exchange',
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    state: state,
  });

  location.assign(loginUrl);
}

async function handleOauthCallback() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  if (!code) {
    // 혹시 URL에 token 파라미터로 바로 넘어온 경우도 안전하게 처리
    const directToken = p.get('token');
    if (directToken) {
      token = directToken;
      localStorage.setItem(AUTH_KEY, token);
      history.replaceState(null, '', location.pathname);
      toast('🎉 로그인 완료! 잔고가 연동되었습니다.');
    }
    return;
  }

  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null');
  sessionStorage.removeItem(PKCE_KEY);
  history.replaceState(null, '', location.pathname);

  if (!saved || saved.state !== p.get('state')) {
    throw new Error('로그인 검증(State)에 실패했습니다. 다시 시도해 주세요.');
  }

  const oneid = CFG?.oneidUrl || 'https://oneid-icvq.onrender.com';
  const res = await fetch(`${oneid}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CFG?.clientId || 'nexus-exchange',
      redirect_uri: redirectUri(),
      code: code,
      code_verifier: saved.verifier
    })
  });

  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(d.detail || 'ONEID 로그인 토큰 교환에 실패했습니다.');
  }

  token = d.access_token;
  localStorage.setItem(AUTH_KEY, token);
  closeLoginModal();
  toast('🎉 ONEID 로그인 성공! 슬롯 머니 및 지갑이 연동되었습니다.');
}

async function startGuestLogin() {
  const nickname = $('guestNameInput').value.trim() || '체험투자자';
  try {
    const res = await api('/api/guest-login', {
      method: 'POST',
      body: { nickname }
    });
    token = res.token;
    localStorage.setItem(AUTH_KEY, token);
    closeLoginModal();
    toast(`👋 [${res.user.name}]님 환영합니다! 체험 지원금이 지급되었습니다.`);
    await loadUserState();
  } catch (err) {
    alert(err.message || '게스트 입장 실패');
  }
}

// ---------- 이벤트 바인딩 ----------
function setupEvents() {
  $('tabBuy').onclick = () => switchTradeTab('buy');
  $('tabSell').onclick = () => switchTradeTab('sell');

  $('orderSharesInput').oninput = updateTradeCalc;

  // 비율 버튼
  document.querySelectorAll('.btn-pct').forEach(btn => {
    btn.onclick = () => {
      const pct = Number(btn.dataset.pct);
      if (!selectedStock) return;
      const p = selectedStock.current_price;

      if (currentTradeTab === 'buy') {
        const max = Math.floor(balance / p);
        $('orderSharesInput').value = Math.max(1, Math.floor(max * pct));
      } else {
        const myH = portfolio.find(h => h.stock_id === selectedStock.id);
        const max = myH ? Number(myH.shares) : 0;
        $('orderSharesInput').value = Math.max(1, Math.floor(max * pct));
      }
      updateTradeCalc();
    };
  });

  $('submitOrderBtn').onclick = submitTradeOrder;

  // 종목 탭 필터 (전체 / 유저 / 내보유)
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderStockList();
    };
  });

  $('stockSearchInput').oninput = renderStockList;

  // 하단 탭 (포트폴리오 / 뉴스)
  $('bTabPortfolio').onclick = () => {
    $('bTabPortfolio').classList.add('active');
    $('bTabNews').classList.remove('active');
    $('portfolioView').style.display = 'flex';
    $('newsView').style.display = 'none';
  };
  $('bTabNews').onclick = () => {
    $('bTabNews').classList.add('active');
    $('bTabPortfolio').classList.remove('active');
    $('newsView').style.display = 'flex';
    $('portfolioView').style.display = 'none';
  };

  // IPO 모달
  $('openIpoBtn').onclick = openIpoModal;
  $('closeIpoBtn').onclick = closeIpoModal;
  $('cancelIpoBtn').onclick = closeIpoModal;
  $('ipoBackdrop').onclick = e => { if (e.target === $('ipoBackdrop')) closeIpoModal(); };
  $('ipoPrice').oninput = updateIpoPreview;
  $('ipoShares').oninput = updateIpoPreview;
  $('submitIpoBtn').onclick = handleIpoSubmit;

  // 로그인 모달
  $('authBtn').onclick = () => {
    if (token) {
      if (confirm('로그아웃 하시겠습니까?')) {
        token = null;
        localStorage.removeItem(AUTH_KEY);
        loadUserState();
        toast('로그아웃되었습니다.');
      }
    } else {
      openLoginModal();
    }
  };
  $('closeLoginBtn').onclick = closeLoginModal;
  $('loginBackdrop').onclick = e => { if (e.target === $('loginBackdrop')) closeLoginModal(); };
  $('oneidLoginBtn').onclick = startOneidLogin;
  $('guestLoginBtn').onclick = startGuestLogin;

  if ($('tokenPasteBtn')) {
    $('tokenPasteBtn').onclick = async () => {
      const paste = $('tokenPasteInput').value.trim();
      if (!paste) return alert('토큰을 입력해주세요.');
      token = paste;
      localStorage.setItem(AUTH_KEY, token);
      closeLoginModal();
      await loadUserState(true);
      toast('토큰이 적용되었습니다.');
    };
  }
}
