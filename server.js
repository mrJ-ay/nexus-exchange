/* =========================================================
   NEXUS EXCHANGE (넥서스 증권거래소) — Express Server
   - 포트: 5506
   - ONEID SSO 및 슬롯머신 / 자켓마트 자금 실시간 연동
   - 실시간 주가 틱 엔진 및 유저 주식 상장 (IPO)
   ========================================================= */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  initSchema, getPlayer, getAllStocks, getStockDetail,
  getUserPortfolio, buyStock, sellStock, createIPO,
  tickMarket, getRecentNews, IPO_FEE
} from './lib/db.js';
import { requireAuth, ONEID_URL, CLIENT_ID } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5506);
const SLOTS_URL = (process.env.SLOTS_URL || 'https://vegas-slots-2izy.onrender.com').replace(/\/$/, '');
const JARKET_URL = (process.env.JARKET_URL || 'https://jarket.onrender.com').replace(/\/$/, '');

await initSchema();

// 실시간 1.0초 쾌속 틱 엔진 (코인은 매초 ±3~8% 급등락, 일반주는 2초마다 안정적 파동)
let tickCounter = 0;
setInterval(() => {
  tickCounter++;
  tickMarket(tickCounter).catch(e => console.error('[Market Tick Loop Error]', e));
}, 1000);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 기본 설정 및 상태 ----------
app.get('/api/config', (req, res) => {
  res.json({
    exchangeName: 'NEXUS EXCHANGE',
    slogan: '모든 자금과 기업이 교차하는 하이엔드 금융 허브',
    oneidUrl: (process.env.ONEID_PUBLIC_URL || ONEID_URL).replace(/\/$/, ''),
    clientId: CLIENT_ID,
    slotsUrl: SLOTS_URL,
    jarketUrl: JARKET_URL,
    ipoFee: IPO_FEE,
  });
});

// ---------- 전체 상장 종목 목록 ----------
app.get('/api/stocks', async (req, res) => {
  try {
    const stocks = await getAllStocks();
    res.json({ ok: true, stocks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 단일 종목 상세 및 캔들 차트 이력 ----------
app.get('/api/stocks/:id', async (req, res) => {
  try {
    const data = await getStockDetail(req.params.id);
    if (!data) return res.status(404).json({ error: '해당 종목을 찾을 수 없습니다.' });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 증시 공시 및 속보 뉴스 ----------
app.get('/api/news', async (req, res) => {
  try {
    const news = await getRecentNews();
    res.json({ ok: true, news });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 게스트 간편 입장 ----------
app.post('/api/guest-login', async (req, res) => {
  try {
    const nickname = (req.body?.nickname || '체험투자자').trim().slice(0, 15);
    const guestId = 'guest_' + Math.random().toString(36).slice(2, 10);
    const token = `${guestId}_${encodeURIComponent(nickname)}`;
    const player = await getPlayer(guestId, nickname);
    res.json({ token, user: { id: player.id, name: player.name, isGuest: true }, balance: player.balance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- 내 정보 & 잔고 & 포트폴리오 ----------
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const player = await getPlayer(req.user.id, req.user.name);
    const portfolio = await getUserPortfolio(req.user.id);

    const totalInvested = portfolio.reduce((sum, h) => sum + Number(h.total_invested || 0), 0);
    const totalEvaluation = portfolio.reduce((sum, h) => sum + Number(h.current_eval || 0), 0);
    const totalProfit = totalEvaluation - totalInvested;
    const profitRate = totalInvested > 0 ? Number(((totalProfit / totalInvested) * 100).toFixed(2)) : 0;

    res.json({
      ok: true,
      user: {
        id: player.id,
        name: player.name,
        credit: player.credit,
        isGuest: req.user.isGuest
      },
      balance: player.balance,
      portfolio,
      summary: {
        totalInvested,
        totalEvaluation,
        totalProfit,
        profitRate
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 주식 매수 (Buy) ----------
app.post('/api/stocks/buy', requireAuth, async (req, res) => {
  try {
    const { stockId, shares } = req.body || {};
    const result = await buyStock({
      uid: req.user.id,
      userName: req.user.name,
      stockId,
      shares
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- 주식 매도 (Sell) ----------
app.post('/api/stocks/sell', requireAuth, async (req, res) => {
  try {
    const { stockId, shares } = req.body || {};
    const result = await sellStock({
      uid: req.user.id,
      userName: req.user.name,
      stockId,
      shares
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- 기업공개 / 신규 주식 상장 (IPO) ----------
app.post('/api/stocks/ipo', requireAuth, async (req, res) => {
  try {
    const { name, ticker, icon, description, initialPrice, totalShares } = req.body || {};
    const result = await createIPO({
      uid: req.user.id,
      userName: req.user.name,
      name,
      ticker,
      icon,
      description,
      initialPrice,
      totalShares
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`🏛️ NEXUS EXCHANGE → http://localhost:${PORT}  (ONEID: ${ONEID_URL})`);
});
