/* =========================================================
   NEXUS EXCHANGE (넥서스 증권거래소) — 데이터베이스 & 시장 엔진
   - 공유 Neon Postgres (ns_players, ns_ledger, jk_inventory 연동)
   - 실시간 2.5초 틱 주가 변동 및 캔들스틱 생성 엔진
   - 유저 신규 주식 상장 (IPO) & 지분 분배
   ========================================================= */
import pg from 'pg';

pg.types.setTypeParser(20, v => Number(v)); // BIGINT to number
pg.types.setTypeParser(1700, v => parseFloat(v)); // NUMERIC to number

const connectionString = process.env.DATABASE_URL;
let dbAvailable = false;
let pool = null;

if (connectionString) {
  pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', err => console.error('[NEXUS DB Pool Error]', err));
}

// 메모리 폴백
const memStocks = [];
const memHoldings = new Map(); // `${uid}:${stockId}` -> { shares, avg_buy_price, total_invested }
const memHistory = new Map();  // stockId -> [candles]
const memNews = [];
const memPlayers = new Map();

export async function initSchema() {
  if (!pool) {
    console.warn('[NEXUS DB] No DATABASE_URL, using in-memory mode.');
    initSeedMemory();
    return;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        -- 1. 상장 종목 테이블
        CREATE TABLE IF NOT EXISTS ns_stocks (
          id               SERIAL PRIMARY KEY,
          ticker           TEXT UNIQUE NOT NULL,
          name             TEXT NOT NULL,
          description      TEXT,
          icon             TEXT NOT NULL DEFAULT '📈',
          creator_id       TEXT,
          creator_name     TEXT,
          current_price    BIGINT NOT NULL CHECK (current_price > 0),
          prev_close_price BIGINT NOT NULL CHECK (prev_close_price > 0),
          total_shares     BIGINT NOT NULL CHECK (total_shares > 0),
          available_shares BIGINT NOT NULL CHECK (available_shares >= 0),
          high_price       BIGINT NOT NULL,
          low_price        BIGINT NOT NULL,
          volume_24h       BIGINT NOT NULL DEFAULT 0,
          is_system        BOOLEAN NOT NULL DEFAULT false,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ns_stocks_ticker_idx ON ns_stocks (ticker);

        -- 2. 유저별 보유 주식 (포트폴리오)
        CREATE TABLE IF NOT EXISTS ns_stock_holdings (
          id             SERIAL PRIMARY KEY,
          user_id        TEXT NOT NULL,
          stock_id       INTEGER NOT NULL REFERENCES ns_stocks(id) ON DELETE CASCADE,
          shares         BIGINT NOT NULL DEFAULT 0 CHECK (shares >= 0),
          avg_buy_price  NUMERIC(14,2) NOT NULL DEFAULT 0,
          total_invested BIGINT NOT NULL DEFAULT 0,
          UNIQUE(user_id, stock_id)
        );
        CREATE INDEX IF NOT EXISTS ns_stock_holdings_user_idx ON ns_stock_holdings (user_id);

        -- 3. 차트용 캔들 / 틱 히스토리
        CREATE TABLE IF NOT EXISTS ns_stock_history (
          id       BIGSERIAL PRIMARY KEY,
          stock_id INTEGER NOT NULL REFERENCES ns_stocks(id) ON DELETE CASCADE,
          open     BIGINT NOT NULL,
          high     BIGINT NOT NULL,
          low      BIGINT NOT NULL,
          close    BIGINT NOT NULL,
          volume   BIGINT NOT NULL DEFAULT 0,
          at       TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ns_stock_hist_stock_idx ON ns_stock_history (stock_id, at DESC);

        -- 4. 증시 속보 / 공시 뉴스
        CREATE TABLE IF NOT EXISTS ns_stock_news (
          id         SERIAL PRIMARY KEY,
          stock_id   INTEGER REFERENCES ns_stocks(id) ON DELETE SET NULL,
          headline   TEXT NOT NULL,
          impact     NUMERIC(5,2) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      // 5. 기본 1호 상장 종목: (주)자켓홀딩스 시드 생성
      const { rows: exist } = await client.query("SELECT id FROM ns_stocks WHERE ticker = 'JARKET'");
      if (!exist.length) {
        const initPrice = 10000;
        const totalShares = 1000000;
        const res = await client.query(`
          INSERT INTO ns_stocks (
            ticker, name, description, icon, creator_id, creator_name,
            current_price, prev_close_price, total_shares, available_shares,
            high_price, low_price, volume_24h, is_system
          ) VALUES (
            'JARKET', '(주)자켓홀딩스', '대한민국 유통과 카지노의 중심, Everyday Low Profit 자켓마트 지주회사', '🛒',
            NULL, 'NEXUS SYSTEM',
            $1, $1, $2, $2,
            $1, $1, 14200, true
          ) RETURNING id
        `, [initPrice, totalShares]);
        
        const stockId = res.rows[0].id;

        // 초기 30개 더미 캔들스틱 생성 (차트가 즉시 예쁘게 보이도록)
        let cur = initPrice;
        const now = Date.now();
        for (let i = 30; i >= 1; i--) {
          const delta = (Math.random() - 0.48) * 200;
          const open = Math.round(cur);
          const close = Math.max(100, Math.round(cur + delta));
          const high = Math.max(open, close) + Math.round(Math.random() * 80);
          const low = Math.max(50, Math.min(open, close) - Math.round(Math.random() * 80));
          const vol = Math.round(Math.random() * 1500 + 200);
          const time = new Date(now - i * 60000);
          await client.query(`
            INSERT INTO ns_stock_history (stock_id, open, high, low, close, volume, at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [stockId, open, high, low, close, vol, time]);
          cur = close;
        }

        // 초기 뉴스 1건
        await client.query(`
          INSERT INTO ns_stock_news (stock_id, headline, impact)
          VALUES ($1, '📢 [공시] (주)자켓홀딩스, 멸종 매머드육 독점 수출 계약 체결로 1분기 흑자 달성!', 0.05)
        `, [stockId]);
      }

      dbAvailable = true;
      console.log('[NEXUS DB] Schema initialized successfully.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('[NEXUS DB] Connection failed, switching to memory mode:', err.message);
    dbAvailable = false;
    initSeedMemory();
  }
}

function initSeedMemory() {
  if (memStocks.length) return;
  const initPrice = 10000;
  memStocks.push({
    id: 1,
    ticker: 'JARKET',
    name: '(주)자켓홀딩스',
    description: '대한민국 유통과 카지노의 중심, Everyday Low Profit 자켓마트 지주회사',
    icon: '🛒',
    creator_id: null,
    creator_name: 'NEXUS SYSTEM',
    current_price: initPrice,
    prev_close_price: initPrice,
    total_shares: 1000000,
    available_shares: 1000000,
    high_price: initPrice,
    low_price: initPrice,
    volume_24h: 12500,
    is_system: true,
    created_at: new Date().toISOString()
  });

  const candles = [];
  let cur = initPrice;
  const now = Date.now();
  for (let i = 30; i >= 1; i--) {
    const delta = (Math.random() - 0.48) * 200;
    const open = Math.round(cur);
    const close = Math.max(100, Math.round(cur + delta));
    const high = Math.max(open, close) + Math.round(Math.random() * 80);
    const low = Math.max(50, Math.min(open, close) - Math.round(Math.random() * 80));
    candles.push({
      open, high, low, close, volume: Math.round(Math.random() * 1000 + 200),
      at: new Date(now - i * 60000).toISOString()
    });
    cur = close;
  }
  memHistory.set(1, candles);
  memNews.push({
    id: 1,
    stock_id: 1,
    headline: '📢 [공시] (주)자켓홀딩스, 멸종 매머드육 독점 수출 계약 체결!',
    impact: 0.05,
    created_at: new Date().toISOString()
  });
}

/** 플레이어 조회 (없으면 기본 생성) */
export async function getPlayer(uid, fallbackName = 'NEXUS투자자') {
  if (dbAvailable) {
    let res = await pool.query('SELECT * FROM ns_players WHERE id = $1', [uid]);
    if (!res.rows.length) {
      await pool.query(
        `INSERT INTO ns_players (id, name, balance, credit)
         VALUES ($1, $2, 1000, 500)
         ON CONFLICT (id) DO NOTHING`,
        [uid, fallbackName]
      );
      res = await pool.query('SELECT * FROM ns_players WHERE id = $1', [uid]);
    }
    return res.rows[0];
  } else {
    if (!memPlayers.has(uid)) {
      memPlayers.set(uid, {
        id: uid,
        name: fallbackName,
        balance: 100000,
        credit: 600
      });
    }
    return memPlayers.get(uid);
  }
}

/** 전체 상장 종목 목록 조회 */
export async function getAllStocks() {
  if (dbAvailable) {
    const { rows } = await pool.query(`
      SELECT 
        s.*,
        ROUND(((s.current_price - s.prev_close_price)::numeric / s.prev_close_price * 100), 2) AS change_rate,
        (s.current_price - s.prev_close_price) AS change_amount
      FROM ns_stocks s
      ORDER BY s.is_system DESC, s.volume_24h DESC, s.id ASC
    `);
    return rows;
  } else {
    return memStocks.map(s => {
      const change_amount = s.current_price - s.prev_close_price;
      const change_rate = Number(((change_amount / s.prev_close_price) * 100).toFixed(2));
      return { ...s, change_amount, change_rate };
    });
  }
}

/** 단일 종목 상세 및 캔들 차트 이력 (최근 60개) */
export async function getStockDetail(stockId) {
  const numId = Number(stockId);
  if (dbAvailable) {
    const { rows: [stock] } = await pool.query(`
      SELECT 
        s.*,
        ROUND(((s.current_price - s.prev_close_price)::numeric / s.prev_close_price * 100), 2) AS change_rate,
        (s.current_price - s.prev_close_price) AS change_amount
      FROM ns_stocks s
      WHERE s.id = $1
    `, [numId]);

    if (!stock) return null;

    const { rows: history } = await pool.query(`
      SELECT open, high, low, close, volume, at
      FROM ns_stock_history
      WHERE stock_id = $1
      ORDER BY at ASC
      LIMIT 80
    `, [numId]);

    return { stock, history };
  } else {
    const stock = memStocks.find(s => s.id === numId);
    if (!stock) return null;
    const history = memHistory.get(numId) || [];
    const change_amount = stock.current_price - stock.prev_close_price;
    const change_rate = Number(((change_amount / stock.prev_close_price) * 100).toFixed(2));
    return { stock: { ...stock, change_amount, change_rate }, history };
  }
}

/** 유저 보유 주식 포트폴리오 조회 */
export async function getUserPortfolio(uid) {
  if (dbAvailable) {
    const { rows } = await pool.query(`
      SELECT 
        h.stock_id,
        h.shares,
        h.avg_buy_price,
        h.total_invested,
        s.ticker,
        s.name,
        s.icon,
        s.current_price,
        (h.shares * s.current_price) AS current_eval,
        ((h.shares * s.current_price) - h.total_invested) AS profit_amount,
        CASE WHEN h.total_invested > 0 
          THEN ROUND((((h.shares * s.current_price) - h.total_invested)::numeric / h.total_invested * 100), 2)
          ELSE 0 
        END AS profit_rate,
        (s.creator_id = $1) AS is_founder
      FROM ns_stock_holdings h
      JOIN ns_stocks s ON h.stock_id = s.id
      WHERE h.user_id = $1 AND h.shares > 0
      ORDER BY current_eval DESC
    `, [uid]);
    return rows;
  } else {
    const results = [];
    for (const [key, h] of memHoldings.entries()) {
      if (key.startsWith(`${uid}:`) && h.shares > 0) {
        const s = memStocks.find(item => item.id === h.stock_id);
        if (s) {
          const current_eval = h.shares * s.current_price;
          const profit_amount = current_eval - h.total_invested;
          const profit_rate = h.total_invested > 0 ? Number(((profit_amount / h.total_invested) * 100).toFixed(2)) : 0;
          results.push({
            ...h,
            ticker: s.ticker,
            name: s.name,
            icon: s.icon,
            current_price: s.current_price,
            current_eval,
            profit_amount,
            profit_rate,
            is_founder: s.creator_id === uid
          });
        }
      }
    }
    return results;
  }
}

/** 주식 매수 (Market Buy) */
export async function buyStock({ uid, userName, stockId, shares }) {
  shares = Number(shares);
  stockId = Number(stockId);
  if (!shares || shares <= 0 || !Number.isInteger(shares)) {
    throw new Error('매수 수량은 1주 이상의 정수여야 합니다.');
  }

  if (dbAvailable) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 주식 및 잔여 물량 확인
      const { rows: [stock] } = await client.query(
        'SELECT * FROM ns_stocks WHERE id = $1 FOR UPDATE',
        [stockId]
      );
      if (!stock) throw new Error('종목을 찾을 수 없습니다.');
      if (stock.available_shares < shares) {
        throw new Error(`시장에 매수 가능한 잔여 주식이 부족합니다. (잔여: ${stock.available_shares.toLocaleString()}주)`);
      }

      // 2. 유저 잔고 확인
      const totalCost = shares * stock.current_price;
      const { rows: [player] } = await client.query(
        'SELECT * FROM ns_players WHERE id = $1 FOR UPDATE',
        [uid]
      );
      if (!player || player.balance < totalCost) {
        throw new Error(`잔고가 부족합니다! (필요: $${totalCost.toLocaleString()} / 보유: $${(player?.balance || 0).toLocaleString()})`);
      }

      // 3. 잔고 차감 및 원장 기록
      await client.query(
        'UPDATE ns_players SET balance = balance - $1 WHERE id = $2',
        [totalCost, uid]
      );
      await client.query(
        `INSERT INTO ns_ledger (player_id, delta, balance_after, reason, ref)
         VALUES ($1, $2, $3, 'nexus_stock_buy', $4)`,
        [uid, -totalCost, player.balance - totalCost, `${stock.ticker}:${shares}주`]
      );

      // 4. 보유 지분 갱신 (평균 단가 재계산)
      const { rows: [existHolding] } = await client.query(
        'SELECT * FROM ns_stock_holdings WHERE user_id = $1 AND stock_id = $2 FOR UPDATE',
        [uid, stockId]
      );

      let newHolding;
      if (existHolding) {
        const newShares = existHolding.shares + shares;
        const newTotalInvested = existHolding.total_invested + totalCost;
        const newAvg = Number((newTotalInvested / newShares).toFixed(2));
        const res = await client.query(`
          UPDATE ns_stock_holdings
          SET shares = $1, avg_buy_price = $2, total_invested = $3
          WHERE user_id = $4 AND stock_id = $5
          RETURNING *
        `, [newShares, newAvg, newTotalInvested, uid, stockId]);
        newHolding = res.rows[0];
      } else {
        const res = await client.query(`
          INSERT INTO ns_stock_holdings (user_id, stock_id, shares, avg_buy_price, total_invested)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [uid, stockId, shares, stock.current_price, totalCost]);
        newHolding = res.rows[0];
      }

      // 5. 수급 반영 주가 미세 상승 (매수 압력: 최대 +2% 한도)
      const priceImpact = Math.min(1.02, 1.0 + (shares / stock.total_shares) * 0.5);
      const newPrice = Math.max(1, Math.round(stock.current_price * priceImpact));
      const newHigh = Math.max(stock.high_price, newPrice);

      await client.query(`
        UPDATE ns_stocks
        SET available_shares = available_shares - $1,
            volume_24h = volume_24h + $1,
            current_price = $2,
            high_price = $3
        WHERE id = $4
      `, [shares, newPrice, newHigh, stockId]);

      await client.query('COMMIT');
      return {
        ok: true,
        shares,
        totalCost,
        balanceAfter: player.balance - totalCost,
        holding: newHolding,
        stockName: stock.name
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // 메모리 모드
    const stock = memStocks.find(s => s.id === stockId);
    if (!stock) throw new Error('종목을 찾을 수 없습니다.');
    if (stock.available_shares < shares) throw new Error('잔여 주식이 부족합니다.');

    const totalCost = shares * stock.current_price;
    const player = await getPlayer(uid, userName);
    if (player.balance < totalCost) throw new Error('잔고가 부족합니다.');

    player.balance -= totalCost;
    stock.available_shares -= shares;
    stock.volume_24h += shares;

    const key = `${uid}:${stockId}`;
    const exist = memHoldings.get(key);
    if (exist) {
      exist.shares += shares;
      exist.total_invested += totalCost;
      exist.avg_buy_price = Number((exist.total_invested / exist.shares).toFixed(2));
    } else {
      memHoldings.set(key, {
        user_id: uid,
        stock_id: stockId,
        shares,
        avg_buy_price: stock.current_price,
        total_invested: totalCost
      });
    }

    return {
      ok: true,
      shares,
      totalCost,
      balanceAfter: player.balance,
      holding: memHoldings.get(key),
      stockName: stock.name
    };
  }
}

/** 주식 매도 (Market Sell) - 손절 시 자켓마트 화장지(보험) 연동 지원 */
export async function sellStock({ uid, userName, stockId, shares }) {
  shares = Number(shares);
  stockId = Number(stockId);
  if (!shares || shares <= 0 || !Number.isInteger(shares)) {
    throw new Error('매도 수량은 1주 이상의 정수여야 합니다.');
  }

  if (dbAvailable) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 보유 주식 확인
      const { rows: [holding] } = await client.query(
        'SELECT * FROM ns_stock_holdings WHERE user_id = $1 AND stock_id = $2 FOR UPDATE',
        [uid, stockId]
      );
      if (!holding || holding.shares < shares) {
        throw new Error(`보유 주식이 부족합니다. (보유: ${(holding?.shares || 0).toLocaleString()}주)`);
      }

      // 2. 종목 정보 확인
      const { rows: [stock] } = await client.query(
        'SELECT * FROM ns_stocks WHERE id = $1 FOR UPDATE',
        [stockId]
      );
      if (!stock) throw new Error('종목을 찾을 수 없습니다.');

      // 3. 매도 정산 및 손익 계산
      const revenue = shares * stock.current_price;
      const costBasis = Math.round(shares * holding.avg_buy_price);
      const profitLoss = revenue - costBasis;

      // 4. 자켓마트 눈물의 손절 보험 확인 (nm_tissue 화장지 보유 시 손실 30% 환급)
      let insuranceRefund = 0;
      if (profitLoss < 0) {
        const { rows: tissues } = await client.query(
          "SELECT quantity FROM jk_inventory WHERE user_id = $1 AND item_id = 'nm_tissue' AND quantity > 0",
          [uid]
        );
        if (tissues.length && tissues[0].quantity > 0) {
          const loss = Math.abs(profitLoss);
          insuranceRefund = Math.round(loss * 0.3); // 30% 손실 위로금 지급
        }
      }

      const totalPayout = revenue + insuranceRefund;

      // 5. 잔고 지급 및 원장 기록
      const { rows: [player] } = await client.query(
        'UPDATE ns_players SET balance = balance + $1 WHERE id = $2 RETURNING balance',
        [totalPayout, uid]
      );

      await client.query(
        `INSERT INTO ns_ledger (player_id, delta, balance_after, reason, ref)
         VALUES ($1, $2, $3, 'nexus_stock_sell', $4)`,
        [uid, totalPayout, player.balance, `${stock.ticker}:${shares}주:손익$${profitLoss}:보험$${insuranceRefund}`]
      );

      // 6. 보유 지분 차감
      if (holding.shares === shares) {
        await client.query(
          'DELETE FROM ns_stock_holdings WHERE user_id = $1 AND stock_id = $2',
          [uid, stockId]
        );
      } else {
        const remainingShares = holding.shares - shares;
        const remainingInvested = Math.max(0, holding.total_invested - costBasis);
        await client.query(`
          UPDATE ns_stock_holdings
          SET shares = $1, total_invested = $2
          WHERE user_id = $3 AND stock_id = $4
        `, [remainingShares, remainingInvested, uid, stockId]);
      }

      // 7. 매도 물량 시장 반환 및 매도 압력 (최대 -2% 하락)
      const sellImpact = Math.max(0.98, 1.0 - (shares / stock.total_shares) * 0.5);
      const newPrice = Math.max(10, Math.round(stock.current_price * sellImpact));
      const newLow = Math.min(stock.low_price, newPrice);

      await client.query(`
        UPDATE ns_stocks
        SET available_shares = available_shares + $1,
            volume_24h = volume_24h + $1,
            current_price = $2,
            low_price = $3
        WHERE id = $4
      `, [shares, newPrice, newLow, stockId]);

      await client.query('COMMIT');
      return {
        ok: true,
        shares,
        revenue,
        profitLoss,
        insuranceRefund,
        totalPayout,
        balanceAfter: player.balance,
        stockName: stock.name
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // 메모리 모드
    const key = `${uid}:${stockId}`;
    const holding = memHoldings.get(key);
    if (!holding || holding.shares < shares) throw new Error('보유 주식이 부족합니다.');

    const stock = memStocks.find(s => s.id === stockId);
    const revenue = shares * stock.current_price;
    const costBasis = Math.round(shares * holding.avg_buy_price);
    const profitLoss = revenue - costBasis;

    const player = await getPlayer(uid, userName);
    player.balance += revenue;

    holding.shares -= shares;
    if (holding.shares <= 0) {
      memHoldings.delete(key);
    } else {
      holding.total_invested = Math.max(0, holding.total_invested - costBasis);
    }

    stock.available_shares += shares;
    stock.volume_24h += shares;

    return {
      ok: true,
      shares,
      revenue,
      profitLoss,
      insuranceRefund: 0,
      totalPayout: revenue,
      balanceAfter: player.balance,
      stockName: stock.name
    };
  }
}

/** 기업공개 / 신규 주식 상장 (IPO) */
export const IPO_FEE = 500000; // 상장 심사 자본금 50만 칩

export async function createIPO({ uid, userName, name, ticker, icon, description, initialPrice, totalShares }) {
  name = (name || '').trim().slice(0, 30);
  ticker = (ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  icon = (icon || '📈').trim().slice(0, 5);
  description = (description || '').trim().slice(0, 200);
  initialPrice = Math.max(10, Math.min(1000000, Number(initialPrice) || 1000));
  totalShares = Math.max(10000, Math.min(10000000, Number(totalShares) || 100000));

  if (!name || name.length < 2) throw new Error('회사명을 2글자 이상 입력해주세요.');
  if (!ticker || ticker.length < 2) throw new Error('종목 코드(Ticker)는 2~8자리 영문/숫자여야 합니다.');

  if (dbAvailable) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 유저 잔고 확인 (상장 자본금 50만 칩)
      const { rows: [player] } = await client.query(
        'SELECT * FROM ns_players WHERE id = $1 FOR UPDATE',
        [uid]
      );
      if (!player || player.balance < IPO_FEE) {
        throw new Error(`상장 심사 자본금이 부족합니다! (필요: $${IPO_FEE.toLocaleString()} / 현재 잔고: $${(player?.balance || 0).toLocaleString()})`);
      }

      // 2. 티커 중복 확인
      const { rows: existTicker } = await client.query(
        'SELECT id FROM ns_stocks WHERE ticker = $1',
        [ticker]
      );
      if (existTicker.length) {
        throw new Error(`이미 존재하는 종목 코드(${ticker})입니다. 다른 코드를 사용해주세요.`);
      }

      // 3. 자본금 차감 및 원장 기록
      await client.query(
        'UPDATE ns_players SET balance = balance - $1 WHERE id = $2',
        [IPO_FEE, uid]
      );
      await client.query(
        `INSERT INTO ns_ledger (player_id, delta, balance_after, reason, ref)
         VALUES ($1, $2, $3, 'nexus_ipo_fee', $4)`,
        [uid, -IPO_FEE, player.balance - IPO_FEE, `IPO:${ticker}:${name}`]
      );

      // 4. 지분 분배: 창업자(유저) 30% 무상 지급, 시장 공모 70%
      const founderShares = Math.floor(totalShares * 0.3);
      const availableShares = totalShares - founderShares;

      // 5. 종목 생성
      const { rows: [newStock] } = await client.query(`
        INSERT INTO ns_stocks (
          ticker, name, description, icon, creator_id, creator_name,
          current_price, prev_close_price, total_shares, available_shares,
          high_price, low_price, volume_24h, is_system
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $7, $8, $9,
          $7, $7, 0, false
        ) RETURNING *
      `, [ticker, name, description, icon, uid, userName, initialPrice, totalShares, availableShares]);

      // 6. 창업자 계좌에 30% 대주주 지분 입고
      await client.query(`
        INSERT INTO ns_stock_holdings (user_id, stock_id, shares, avg_buy_price, total_invested)
        VALUES ($1, $2, $3, $4, 0)
      `, [uid, newStock.id, founderShares, initialPrice]);

      // 7. 초기 캔들 히스토리 1개 등록
      await client.query(`
        INSERT INTO ns_stock_history (stock_id, open, high, low, close, volume)
        VALUES ($1, $2, $2, $2, $2, 0)
      `, [newStock.id, initialPrice]);

      // 8. 상장 축하 공시 등록
      await client.query(`
        INSERT INTO ns_stock_news (stock_id, headline, impact)
        VALUES ($1, $2, 0.1)
      `, [newStock.id, `🎉 [신규 상장] ${userName} 회장님의 [${name}](${ticker})이 NEXUS 거래소에 정식 상장되었습니다!`]);

      await client.query('COMMIT');
      return {
        ok: true,
        stock: newStock,
        founderShares,
        balanceAfter: player.balance - IPO_FEE
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    // 메모리 모드
    const player = await getPlayer(uid, userName);
    if (player.balance < IPO_FEE) throw new Error('상장 자본금이 부족합니다.');

    if (memStocks.some(s => s.ticker === ticker)) throw new Error('이미 존재하는 종목 코드입니다.');

    player.balance -= IPO_FEE;
    const founderShares = Math.floor(totalShares * 0.3);
    const availableShares = totalShares - founderShares;

    const newStock = {
      id: memStocks.length + 1,
      ticker,
      name,
      description,
      icon,
      creator_id: uid,
      creator_name: userName,
      current_price: initialPrice,
      prev_close_price: initialPrice,
      total_shares: totalShares,
      available_shares: availableShares,
      high_price: initialPrice,
      low_price: initialPrice,
      volume_24h: 0,
      is_system: false,
      created_at: new Date().toISOString()
    };
    memStocks.push(newStock);

    memHoldings.set(`${uid}:${newStock.id}`, {
      user_id: uid,
      stock_id: newStock.id,
      shares: founderShares,
      avg_buy_price: initialPrice,
      total_invested: 0
    });

    memHistory.set(newStock.id, [{
      open: initialPrice,
      high: initialPrice,
      low: initialPrice,
      close: initialPrice,
      volume: 0,
      at: new Date().toISOString()
    }]);

    memNews.unshift({
      id: memNews.length + 1,
      stock_id: newStock.id,
      headline: `🎉 [신규 상장] ${userName} 회장님의 [${name}](${ticker}) 상장!`,
      impact: 0.1,
      created_at: new Date().toISOString()
    });

    return {
      ok: true,
      stock: newStock,
      founderShares,
      balanceAfter: player.balance
    };
  }
}

/** 실시간 2.5초 시장 틱 엔진 (주가 변동 및 캔들 업데이트) */
export async function tickMarket() {
  if (dbAvailable) {
    try {
      const { rows: stocks } = await pool.query('SELECT * FROM ns_stocks');
      for (const stock of stocks) {
        // -2.5% ~ +2.5% 가우시안 랜덤 워크
        const pct = (Math.random() - 0.49) * 0.05;
        const delta = Math.round(stock.current_price * pct);
        const newPrice = Math.max(10, stock.current_price + delta);
        const newHigh = Math.max(stock.high_price, newPrice);
        const newLow = Math.min(stock.low_price, newPrice);

        await pool.query(`
          UPDATE ns_stocks
          SET current_price = $1, high_price = $2, low_price = $3
          WHERE id = $4
        `, [newPrice, newHigh, newLow, stock.id]);

        // 최근 캔들스틱 업데이트 (최근 60초 이내 캔들이면 high/low/close 갱신, 아니면 신규 캔들 생성)
        const { rows: lastCandle } = await pool.query(`
          SELECT * FROM ns_stock_history
          WHERE stock_id = $1
          ORDER BY at DESC LIMIT 1
        `, [stock.id]);

        const now = Date.now();
        if (lastCandle.length && (now - new Date(lastCandle[0].at).getTime() < 30000)) {
          // 기존 캔들 수정
          const c = lastCandle[0];
          await pool.query(`
            UPDATE ns_stock_history
            SET high = GREATEST(high, $1), low = LEAST(low, $1), close = $1
            WHERE id = $2
          `, [newPrice, c.id]);
        } else {
          // 신규 캔들 생성
          await pool.query(`
            INSERT INTO ns_stock_history (stock_id, open, high, low, close, volume)
            VALUES ($1, $2, $2, $2, $2, $3)
          `, [stock.id, newPrice, Math.round(Math.random() * 500)]);
        }
      }
    } catch (e) {
      console.error('[NEXUS Tick Error]', e.message);
    }
  } else {
    // 메모리 모드 틱
    for (const stock of memStocks) {
      const pct = (Math.random() - 0.49) * 0.05;
      const delta = Math.round(stock.current_price * pct);
      stock.current_price = Math.max(10, stock.current_price + delta);
      stock.high_price = Math.max(stock.high_price, stock.current_price);
      stock.low_price = Math.min(stock.low_price, stock.current_price);

      const history = memHistory.get(stock.id) || [];
      const last = history[history.length - 1];
      const now = Date.now();
      if (last && (now - new Date(last.at).getTime() < 30000)) {
        last.high = Math.max(last.high, stock.current_price);
        last.low = Math.min(last.low, stock.current_price);
        last.close = stock.current_price;
      } else {
        history.push({
          open: stock.current_price,
          high: stock.current_price,
          low: stock.current_price,
          close: stock.current_price,
          volume: Math.round(Math.random() * 500),
          at: new Date().toISOString()
        });
        if (history.length > 80) history.shift();
      }
    }
  }
}

/** 최근 공시 뉴스 피드 조회 */
export async function getRecentNews() {
  if (dbAvailable) {
    const { rows } = await pool.query(`
      SELECT n.*, s.ticker, s.name AS stock_name
      FROM ns_stock_news n
      LEFT JOIN ns_stocks s ON n.stock_id = s.id
      ORDER BY n.created_at DESC
      LIMIT 10
    `);
    return rows;
  } else {
    return memNews.slice(0, 10);
  }
}
