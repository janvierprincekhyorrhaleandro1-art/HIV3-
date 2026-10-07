const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const OpenAI = require('openai');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const TRADING_MODE = 'paper';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const bazaarlink = new OpenAI({
  baseURL: 'https://api.bazaarlink.ai/v1',
  apiKey: process.env.BAZAARLINK_API_KEY,
});

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;

const paperAccount = {
  initialBalance: 10000,
  balance: 10000,
  equity: 10000,
  realizedPnL: 0,
  positions: [],
  trades: [],
  lastResetAt: new Date().toISOString(),
};

function normalizeSymbol(symbol) {
  const clean = symbol.toUpperCase().replace('/', '');
  if (clean === 'XAUUSD') return 'XAU/USD';
  if (clean.length === 6) return clean.slice(0, 3) + '/' + clean.slice(3);
  return clean;
}

async function getMarketData(symbol, interval = '5min', outputsize = 30) {
  if (!TWELVE_DATA_KEY) throw new Error('TWELVE_DATA_API_KEY pa konfigire.');
  const formattedSymbol = normalizeSymbol(symbol);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(formattedSymbol)}&interval=${encodeURIComponent(interval)}&outputsize=${outputsize}&apikey=${TWELVE_DATA_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status}`);
  const data = await response.json();
  if (data.status === 'error' || !data.values) {
    throw new Error(data.message || 'Done mache yo pa disponib.');
  }
  return data.values;
}

function hasMarketVolatility(symbol, candleData) {
  if (!candleData || candleData.length < 2) return false;
  const latest = candleData[0];
  const spread = Math.abs(parseFloat(latest.high) - parseFloat(latest.low));
  return symbol.includes('XAU') || symbol.includes('GOLD')
    ? spread >= 0.40
    : spread >= 0.0004;
}

function normalizeAnalysis(analysis, symbol, interval) {
  const allowed = ['BUY', 'SELL'];
  const type = String(analysis.type || '').toUpperCase();
  if (!analysis.has_signal || !allowed.includes(type)) return null;

  const numericFields = ['entry_price', 'tp1', 'tp2', 'sl'];
  for (const field of numericFields) {
    if (analysis[field] !== undefined && analysis[field] !== null) {
      analysis[field] = Number(analysis[field]);
      if (!Number.isFinite(analysis[field])) delete analysis[field];
    }
  }

  return {
    pair: symbol,
    category: symbol.includes('XAU') || symbol.includes('GOLD') ? 'GOLD' : 'FOREX',
    type,
    entry_price: analysis.entry_price,
    tp1: analysis.tp1,
    tp1_pips: analysis.tp1_pips ?? null,
    tp2: analysis.tp2 ?? null,
    tp2_pips: analysis.tp2_pips ?? null,
    sl: analysis.sl,
    sl_pips: analysis.sl_pips ?? null,
    timeframe: interval,
    session: analysis.session || 'Paper Market',
    risk_reward: analysis.risk_reward || '1:2',
    status: 'ACTIVE',
    mode: TRADING_MODE,
  };
}

async function analyzeMarket(symbol, interval = '5min') {
  const candleData = await getMarketData(symbol, interval, 30);

  if (!hasMarketVolatility(symbol, candleData)) {
    return { success: true, message: 'Mache a kalm. Pa gen siyal.', signal: null };
  }

  if (!process.env.BAZAARLINK_API_KEY) {
    throw new Error('BAZAARLINK_API_KEY pa konfigire.');
  }

  const prompt = `
Ou se yon motè analiz pou yon sistèm PAPER TRADING edikatif.
Pa egzekite okenn lòd reyèl. Analize sèlman done bouji yo.

Pair: ${symbol}
Timeframe: ${interval}
Bouji yo:
${JSON.stringify(candleData)}

Si pa gen yon opòtinite klè, retounen egzakteman:
{"has_signal":false}

Si gen yon setup ki klè, retounen sèlman JSON:
{
  "has_signal": true,
  "type": "BUY" oswa "SELL",
  "entry_price": number,
  "tp1": number,
  "tp2": number,
  "sl": number,
  "tp1_pips": number,
  "tp2_pips": number,
  "sl_pips": number,
  "session": "Paper Market",
  "risk_reward": "1:2"
}

Pa envante done ki pa nan candles yo. Si risk la pa klè, pa bay signal.
`;

  const completion = await bazaarlink.chat.completions.create({
    model: 'qwen3.7-flash',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
  });

  const responseText = completion.choices?.[0]?.message?.content?.trim() || '';
  const cleanJson = responseText.replace(/\`\`\`json|\`\`\`/g, '').trim();
  const analysis = JSON.parse(cleanJson);
  const signal = normalizeAnalysis(analysis, symbol, interval);

  if (!signal) return { success: true, message: 'Pa gen setup ki ase klè.', signal: null };

  const { data, error } = await supabase
    .from('signals')
    .insert([signal])
    .select()
    .single();

  if (error) throw error;

  return { success: true, signal: data || signal };
}

function getPaperState() {
  const openPositions = paperAccount.positions.filter(p => p.status === 'OPEN');
  paperAccount.equity = paperAccount.balance + openPositions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
  return {
    mode: TRADING_MODE,
    initialBalance: paperAccount.initialBalance,
    balance: Number(paperAccount.balance.toFixed(2)),
    equity: Number(paperAccount.equity.toFixed(2)),
    realizedPnL: Number(paperAccount.realizedPnL.toFixed(2)),
    openPositions,
    trades: paperAccount.trades.slice(-50).reverse(),
    lastResetAt: paperAccount.lastResetAt,
  };
}

function calculatePnL(position, exitPrice) {
  const direction = position.type === 'BUY' ? 1 : -1;
  const units = position.units || 1000;
  return (exitPrice - position.entry_price) * direction * units;
}

function openPaperPosition(signal) {
  const existing = paperAccount.positions.find(
    p => p.status === 'OPEN' && p.pair === signal.pair
  );
  if (existing) return { created: false, position: existing };

  const position = {
    id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    pair: signal.pair,
    type: signal.type,
    entry_price: Number(signal.entry_price),
    tp1: Number(signal.tp1),
    tp2: signal.tp2 ? Number(signal.tp2) : null,
    sl: Number(signal.sl),
    timeframe: signal.timeframe,
    units: 1000,
    openedAt: new Date().toISOString(),
    status: 'OPEN',
    unrealizedPnL: 0,
  };

  paperAccount.positions.push(position);
  return { created: true, position };
}

async function updatePaperPositions(symbol) {
  const open = paperAccount.positions.filter(p => p.status === 'OPEN' && (!symbol || p.pair === symbol));
  for (const position of open) {
    try {
      const candles = await getMarketData(position.pair, position.timeframe || '5min', 1);
      const latest = candles?.[0];
      if (!latest) continue;

      const high = Number(latest.high);
      const low = Number(latest.low);
      const close = Number(latest.close);

      let exitPrice = null;
      let reason = null;

      if (position.type === 'BUY') {
        if (low <= position.sl) { exitPrice = position.sl; reason = 'STOP_LOSS'; }
        else if (position.tp2 && high >= position.tp2) { exitPrice = position.tp2; reason = 'TAKE_PROFIT_2'; }
        else if (high >= position.tp1) { exitPrice = position.tp1; reason = 'TAKE_PROFIT_1'; }
      } else {
        if (high >= position.sl) { exitPrice = position.sl; reason = 'STOP_LOSS'; }
        else if (position.tp2 && low <= position.tp2) { exitPrice = position.tp2; reason = 'TAKE_PROFIT_2'; }
        else if (low <= position.tp1) { exitPrice = position.tp1; reason = 'TAKE_PROFIT_1'; }
      }

      if (exitPrice !== null) {
        const pnl = calculatePnL(position, exitPrice);
        position.status = 'CLOSED';
        position.exit_price = exitPrice;
        position.closedAt = new Date().toISOString();
        position.closeReason = reason;
        position.realizedPnL = pnl;
        position.unrealizedPnL = 0;
        paperAccount.balance += pnl;
        paperAccount.realizedPnL += pnl;
        paperAccount.trades.push({ ...position });
      } else {
        position.unrealizedPnL = calculatePnL(position, close);
      }
    } catch (err) {
      console.error(`Paper update ${position.pair}:`, err.message);
    }
  }
  return getPaperState();
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: TRADING_MODE,
    service: 'HIV3 Paper Trading Engine',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    mode: TRADING_MODE,
    realTradingEnabled: false,
    supportedSymbols: ['XAUUSD', 'EURUSD', 'GBPUSD'],
    timeframes: ['1min', '5min'],
  });
});

app.get('/api/analyze/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const interval = req.query.interval || '5min';

  try {
    const result = await analyzeMarket(symbol, interval);
    if (result.signal) openPaperPosition(result.signal);
    return res.status(200).json(result);
  } catch (err) {
    console.error('ANALYZE ERROR:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/paper/state', async (req, res) => {
  try {
    await updatePaperPositions();
    res.json(getPaperState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/paper/refresh', async (req, res) => {
  try {
    const state = await updatePaperPositions(req.body?.symbol?.toUpperCase());
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/paper/reset', (req, res) => {
  paperAccount.balance = paperAccount.initialBalance;
  paperAccount.equity = paperAccount.initialBalance;
  paperAccount.realizedPnL = 0;
  paperAccount.positions = [];
  paperAccount.trades = [];
  paperAccount.lastResetAt = new Date().toISOString();
  res.json(getPaperState());
});

// This automation only creates PAPER signals/positions. It can never place broker orders.
cron.schedule('*/7 * * * *', async () => {
  console.log('[PAPER CRON] XAUUSD analysis...');
  try {
    const result = await analyzeMarket('XAUUSD', '5min');
    if (result.signal) openPaperPosition(result.signal);
    await updatePaperPositions('XAUUSD');
  } catch (err) {
    console.error('[PAPER CRON ERROR]', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`HIV3 Paper Trading API running on port ${PORT}. Real trading: DISABLED.`);
});
