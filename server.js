const express = require('express');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const OpenAI = require('openai');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const TRADING_MODE = 'paper';
const botControl = { enabled: true, lastScanAt: null, lastPrice: null, lastMarketAt: null, lastMessage: 'Bot la aktive.' };

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const bazaarlink = process.env.BAZAARLINK_API_KEY
  ? new OpenAI({ baseURL: 'https://api.bazaarlink.ai/v1', apiKey: process.env.BAZAARLINK_API_KEY })
  : null;

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;

const paperAccount = { initialBalance: 10000, balance: 10000, equity: 10000, realizedPnL: 0, positions: [], trades: [], lastResetAt: new Date().toISOString() };
const signalHistory = [];

function normalizeSymbol(symbol) {
  const clean = String(symbol).toUpperCase().replace('/', '');
  if (clean === 'XAUUSD') return 'XAU/USD';
  if (clean.length === 6) return clean.slice(0, 3) + '/' + clean.slice(3);
  return clean;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'HIV3-Paper-Trading/2.1' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`Market data HTTP ${response.statusCode}: ${body.slice(0, 180)}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Market data returned invalid JSON.')); }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Market data timeout.')));
    request.on('error', err => reject(new Error(`Market data network error: ${err.message}`)));
  });
}

async function getMarketData(symbol, interval = '5min', outputsize = 30) {
  if (!TWELVE_DATA_KEY) throw new Error('TWELVE_DATA_API_KEY pa konfigire.');
  const formattedSymbol = normalizeSymbol(symbol);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(formattedSymbol)}&interval=${encodeURIComponent(interval)}&outputsize=${outputsize}&apikey=${encodeURIComponent(TWELVE_DATA_KEY)}`;
  const data = await fetchJson(url);
  if (data.status === 'error' || !Array.isArray(data.values)) throw new Error(data.message || 'Twelve Data pa retounen candles.');
  return data.values;
}

function hasMarketVolatility(symbol, candleData) {
  if (!candleData || candleData.length < 2) return false;
  const latest = candleData[0];
  const spread = Math.abs(Number(latest.high) - Number(latest.low));
  return symbol.includes('XAU') ? spread >= 0.40 : spread >= 0.0004;
}

function normalizeAnalysis(analysis, interval) {
  const type = String(analysis.type || '').toUpperCase();
  if (!analysis.has_signal || !['BUY', 'SELL'].includes(type)) return null;
  for (const field of ['entry_price', 'tp1', 'tp2', 'sl']) {
    if (analysis[field] !== undefined && analysis[field] !== null) {
      analysis[field] = Number(analysis[field]);
      if (!Number.isFinite(analysis[field])) delete analysis[field];
    }
  }
  if (!Number.isFinite(analysis.entry_price) || !Number.isFinite(analysis.tp1) || !Number.isFinite(analysis.sl)) return null;
  return {
    pair: 'XAUUSD', category: 'GOLD', type, entry_price: analysis.entry_price,
    tp1: analysis.tp1, tp1_pips: analysis.tp1_pips ?? null,
    tp2: analysis.tp2 ?? null, tp2_pips: analysis.tp2_pips ?? null,
    sl: analysis.sl, sl_pips: analysis.sl_pips ?? null,
    timeframe: interval, session: analysis.session || 'Paper Market',
    risk_reward: analysis.risk_reward || '1:2', status: 'ACTIVE', mode: TRADING_MODE,
    created_at: new Date().toISOString()
  };
}

function technicalPaperSignal(candles) {
  if (!candles || candles.length < 6) return null;
  const closes = candles.slice(0, 6).map(c => Number(c.close));
  const entry = closes[0], move = entry - closes[5];
  const range = Math.max(...candles.slice(0, 6).map(c => Number(c.high) - Number(c.low)));
  if (!Number.isFinite(entry) || !Number.isFinite(move) || !Number.isFinite(range) || range <= 0) return null;
  const type = move >= 0 ? 'BUY' : 'SELL';
  const distance = Math.max(range * 1.5, 0.8);
  return { has_signal: true, type, entry_price: entry, tp1: type === 'BUY' ? entry + distance * 2 : entry - distance * 2, sl: type === 'BUY' ? entry - distance : entry + distance, session: 'Paper Technical Fallback', risk_reward: '1:2' };
}

async function saveSignal(signal) {
  signalHistory.unshift(signal);
  signalHistory.splice(50);
  if (!supabase) return { ...signal, storage: 'local' };
  try {
    const { data, error } = await supabase.from('signals').insert([signal]).select().single();
    if (error) throw error;
    return data || signal;
  } catch (err) {
    console.error('[SUPABASE SIGNAL FALLBACK]', err.message);
    return { ...signal, storage: 'local', storageError: err.message };
  }
}

async function analyzeMarket(symbol, interval = '5min') {
  const candleData = await getMarketData('XAUUSD', interval, 30);
  const latest = candleData[0];
  if (latest) { botControl.lastPrice = Number(latest.close); botControl.lastMarketAt = latest.datetime || new Date().toISOString(); }
  botControl.lastScanAt = new Date().toISOString();
  if (!hasMarketVolatility(symbol, candleData)) return { success: true, message: 'Mache a kalm. Pa gen siyal.', signal: null };

  let signal = null;
  if (bazaarlink) {
    try {
      const prompt = `Ou se yon motè analiz PAPER TRADING edikatif. Pa egzekite okenn lòd reyèl.
Pair: XAUUSD
Timeframe: ${interval}
Candles: ${JSON.stringify(candleData)}
Si pa gen setup klè, retounen {"has_signal":false}. Sinon retounen sèlman JSON ak has_signal,type,entry_price,tp1,tp2,sl,session,risk_reward.`;
      const completion = await bazaarlink.chat.completions.create({ model: 'qwen3.7-flash', messages: [{ role: 'user', content: prompt }], temperature: 0.2 });
      const text = completion.choices?.[0]?.message?.content?.trim() || '';
      const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim();
      signal = normalizeAnalysis(JSON.parse(clean), interval);
    } catch (err) { console.error('[AI FALLBACK]', err.message); }
  }
  if (!signal) signal = normalizeAnalysis(technicalPaperSignal(candleData), interval);
  if (!signal) return { success: true, message: 'Pa gen setup ki ase klè.', signal: null };
  return { success: true, signal: await saveSignal(signal) };
}

function calculatePnL(position, exitPrice) { return (exitPrice - position.entry_price) * (position.type === 'BUY' ? 1 : -1) * (position.units || 1000); }

function openPaperPosition(signal) {
  const existing = paperAccount.positions.find(p => p.status === 'OPEN' && p.pair === signal.pair);
  if (existing) return { created: false, position: existing };
  const position = { id: `paper_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, pair: signal.pair, type: signal.type, entry_price: Number(signal.entry_price), tp1: Number(signal.tp1), tp2: signal.tp2 ? Number(signal.tp2) : null, sl: Number(signal.sl), timeframe: signal.timeframe, units: 1000, openedAt: new Date().toISOString(), status: 'OPEN', unrealizedPnL: 0 };
  paperAccount.positions.push(position);
  return { created: true, position };
}

async function updatePaperPositions(symbol) {
  const open = paperAccount.positions.filter(p => p.status === 'OPEN' && (!symbol || p.pair === symbol));
  for (const position of open) {
    try {
      const latest = (await getMarketData(position.pair, position.timeframe || '5min', 1))[0];
      if (!latest) continue;
      const high = Number(latest.high), low = Number(latest.low), close = Number(latest.close);
      let exitPrice = null, reason = null;
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
        Object.assign(position, { status: 'CLOSED', exit_price: exitPrice, closedAt: new Date().toISOString(), closeReason: reason, realizedPnL: pnl, unrealizedPnL: 0 });
        paperAccount.balance += pnl; paperAccount.realizedPnL += pnl; paperAccount.trades.push({ ...position });
      } else position.unrealizedPnL = calculatePnL(position, close);
    } catch (err) { console.error(`Paper update ${position.pair}:`, err.message); }
  }
  return getPaperState();
}

function getPaperState() {
  const openPositions = paperAccount.positions.filter(p => p.status === 'OPEN');
  paperAccount.equity = paperAccount.balance + openPositions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
  return { mode: TRADING_MODE, initialBalance: 10000, balance: Number(paperAccount.balance.toFixed(2)), equity: Number(paperAccount.equity.toFixed(2)), realizedPnL: Number(paperAccount.realizedPnL.toFixed(2)), openPositions, trades: paperAccount.trades.slice(-50).reverse(), lastResetAt: paperAccount.lastResetAt };
}

app.get('/api/health', (req,res) => res.json({ ok:true, mode:TRADING_MODE, service:'HIV3 Paper Trading Engine', supabaseConfigured:Boolean(supabase), marketDataConfigured:Boolean(TWELVE_DATA_KEY), aiConfigured:Boolean(bazaarlink), timestamp:new Date().toISOString() }));
app.get('/api/signals', async (req,res) => {
  if (supabase) {
    try {
      const {data,error}=await supabase.from('signals').select('*').order('created_at',{ascending:false}).limit(12);
      if (!error && data?.length) return res.json({success:true,signals:data});
      if (error) console.error('[SUPABASE READ FALLBACK]',error.message);
    } catch(err){ console.error('[SUPABASE READ FALLBACK]',err.message); }
  }
  res.json({success:true,signals:signalHistory.slice(0,12)});
});
app.get('/api/bot/state',(req,res)=>res.json({enabled:botControl.enabled,mode:TRADING_MODE,symbol:'XAUUSD',lastScanAt:botControl.lastScanAt,lastPrice:botControl.lastPrice,lastMarketAt:botControl.lastMarketAt,message:botControl.lastMessage}));
app.post('/api/bot/toggle',(req,res)=>{botControl.enabled=Boolean(req.body?.enabled);botControl.lastMessage=botControl.enabled?'Bot la aktive.':'Bot la dezaktive.';res.json({enabled:botControl.enabled,mode:TRADING_MODE,symbol:'XAUUSD',message:botControl.lastMessage});});
app.get('/api/config',(req,res)=>res.json({mode:TRADING_MODE,realTradingEnabled:false,supportedSymbols:['XAUUSD'],timeframes:['1min','5min']}));
app.get('/api/analyze/:symbol',async(req,res)=>{if(!botControl.enabled)return res.status(423).json({success:false,error:'Bot la OFF.'});try{const result=await analyzeMarket('XAUUSD',req.query.interval||'5min');if(result.signal)openPaperPosition(result.signal);res.json(result);}catch(err){console.error('[ANALYZE ERROR]',err.message);res.status(500).json({success:false,error:err.message});}});
app.get('/api/paper/state',async(req,res)=>{try{await updatePaperPositions();res.json(getPaperState());}catch(err){res.status(500).json({error:err.message,...getPaperState()});}});
app.post('/api/paper/refresh',async(req,res)=>{try{res.json(await updatePaperPositions(req.body?.symbol?.toUpperCase()));}catch(err){res.status(500).json({error:err.message,...getPaperState()});}});
app.post('/api/paper/reset',(req,res)=>{paperAccount.balance=paperAccount.initialBalance;paperAccount.equity=paperAccount.initialBalance;paperAccount.realizedPnL=0;paperAccount.positions=[];paperAccount.trades=[];paperAccount.lastResetAt=new Date().toISOString();signalHistory.length=0;res.json(getPaperState());});

cron.schedule('*/5 * * * *',async()=>{if(!botControl.enabled)return console.log('[PAPER CRON] Bot OFF — scan skipped.');console.log('[PAPER CRON] Automatic XAUUSD analysis...');try{const result=await analyzeMarket('XAUUSD','5min');if(result.signal)openPaperPosition(result.signal);await updatePaperPositions('XAUUSD');console.log('[PAPER CRON] Cycle complete:',getPaperState().balance,getPaperState().equity);}catch(err){console.error('[PAPER CRON ERROR]',err.message);}});

app.listen(PORT,()=>console.log(`HIV3 Paper Trading API running on port ${PORT}. AUTO XAU/USD PAPER MODE. Real trading: DISABLED.`));
