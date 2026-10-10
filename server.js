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
const botControl = { enabled: false, lastScanAt: null, lastPrice: null, lastMarketAt: null, lastMessage: 'Bot la OFF. Aktive l sèlman lè ou vle.' };

const supabase = process.env.SUPABASE_ENABLED === 'true' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// AI provider failover: BazaarLink primary, then Groq, OpenRouter, and Gemini.
const aiProviders = [
  {
    name: 'BazaarLink',
    apiKey: process.env.BAZAARLINK_API_KEY,
    baseURL: 'https://api.bazaarlink.ai/v1',
    model: process.env.BAZAARLINK_MODEL || 'qwen/qwen3.7-flash'
  },
  {
    name: 'Groq',
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
  },
  {
    name: 'OpenRouter',
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free'
  },
  {
    name: 'Gemini',
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'
  }
].filter(provider => Boolean(provider.apiKey));

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;
const marketDataCache = new Map();
const MARKET_DATA_CACHE_MS = 5 * 60 * 1000;

const STARTING_BALANCE = 100;
const paperAccount = { initialBalance: STARTING_BALANCE, balance: STARTING_BALANCE, equity: STARTING_BALANCE, realizedPnL: 0, positions: [], trades: [], lastResetAt: new Date().toISOString() };
const signalHistory = [];

let persistenceReady = false;
function dbPosition(p) {
  return { id:p.id, pair:p.pair, type:p.type, entry_price:p.entry_price, tp1:p.tp1, tp2:p.tp2 ?? null, sl:p.sl,
    timeframe:p.timeframe || '5min', units:p.units || 1, opened_at:p.openedAt || p.opened_at || new Date().toISOString(),
    status:p.status || 'OPEN', unrealized_pnl:p.unrealizedPnL || 0, exit_price:p.exit_price ?? null,
    closed_at:p.closedAt || p.closed_at || null, close_reason:p.closeReason || p.close_reason || null,
    realized_pnl:p.realizedPnL ?? p.realized_pnl ?? null, updated_at:new Date().toISOString() };
}
function appPosition(r) {
  return { id:r.id, pair:r.pair, type:r.type, entry_price:Number(r.entry_price), tp1:Number(r.tp1),
    tp2:r.tp2 == null ? null : Number(r.tp2), sl:Number(r.sl), timeframe:r.timeframe || '5min',
    units:Number(r.units || 1), openedAt:r.opened_at, status:r.status, unrealizedPnL:Number(r.unrealized_pnl || 0),
    exit_price:r.exit_price == null ? null : Number(r.exit_price), closedAt:r.closed_at,
    closeReason:r.close_reason, realizedPnL:r.realized_pnl == null ? null : Number(r.realized_pnl) };
}
async function persistBotEnabled(enabled) {
  if (!supabase) return false;
  const {error}=await supabase.from('bot_settings').upsert({id:'main',enabled:Boolean(enabled),updated_at:new Date().toISOString()},{onConflict:'id'});
  if(error) throw error;
  return true;
}
async function persistPaperState() {
  if (!supabase) return false;
  const open=paperAccount.positions.filter(p=>p.status==='OPEN');
  paperAccount.equity=paperAccount.balance+open.reduce((sum,p)=>sum+(p.unrealizedPnL||0),0);
  const {error:ae}=await supabase.from('paper_accounts').upsert({id:1,initial_balance:paperAccount.initialBalance,balance:paperAccount.balance,equity:paperAccount.equity,realized_pnl:paperAccount.realizedPnL,last_reset_at:paperAccount.lastResetAt,updated_at:new Date().toISOString()},{onConflict:'id'});
  if(ae) throw ae;
  if(paperAccount.positions.length) {
    const {error:pe}=await supabase.from('paper_positions').upsert(paperAccount.positions.map(dbPosition),{onConflict:'id'});
    if(pe) throw pe;
  }
  return true;
}
async function initializePersistentState() {
  if(!supabase) {
    console.error('[SUPABASE] Persistence NOT configured. Set SUPABASE_ENABLED=true, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render.');
    botControl.enabled=false; botControl.lastMessage='Bot OFF: sovgad Supabase pa konekte.'; return;
  }
  try {
    const [{data:settings,error:se},{data:account,error:ae},{data:rows,error:pe}]=await Promise.all([
      supabase.from('bot_settings').select('*').eq('id','main').maybeSingle(),
      supabase.from('paper_accounts').select('*').eq('id',1).maybeSingle(),
      supabase.from('paper_positions').select('*').order('opened_at',{ascending:true})
    ]);
    if(se) throw se; if(ae) throw ae; if(pe) throw pe;
    if(!settings) {
      const {error}=await supabase.from('bot_settings').insert({id:'main',enabled:false});
      if(error) throw error;
      botControl.enabled=false;
    } else botControl.enabled=settings.enabled===true;
    if(!account) {
      paperAccount.initialBalance=STARTING_BALANCE; paperAccount.balance=STARTING_BALANCE;
      paperAccount.equity=STARTING_BALANCE; paperAccount.realizedPnL=0;
      paperAccount.positions=[]; paperAccount.trades=[]; paperAccount.lastResetAt=new Date().toISOString();
      await persistPaperState();
    } else {
      paperAccount.initialBalance=Number(account.initial_balance); paperAccount.balance=Number(account.balance);
      paperAccount.equity=Number(account.equity); paperAccount.realizedPnL=Number(account.realized_pnl);
      paperAccount.lastResetAt=account.last_reset_at; paperAccount.positions=(rows||[]).map(appPosition);
      paperAccount.trades=paperAccount.positions.filter(p=>p.status==='CLOSED').sort((a,b)=>new Date(b.closedAt||0)-new Date(a.closedAt||0)).slice(0,200);
    }
    persistenceReady=true;
    botControl.lastMessage=botControl.enabled?'Bot ON. Eta chaje nan Supabase.':'Bot OFF. Eta chaje nan Supabase.';
    console.log('[SUPABASE] Bot settings, paper account and trade history loaded.');
  } catch(err) {
    persistenceReady=false; botControl.enabled=false; botControl.lastMessage='Bot OFF: Supabase pa kapab chaje sovgad la.';
    console.error('[SUPABASE INIT ERROR]',err.message);
  }
}

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
  const cacheKey = `${formattedSymbol}|${interval}|${outputsize}`;
  const cached = marketDataCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < MARKET_DATA_CACHE_MS) return cached.values;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(formattedSymbol)}&interval=${encodeURIComponent(interval)}&outputsize=${outputsize}&apikey=${encodeURIComponent(TWELVE_DATA_KEY)}`;
  const data = await fetchJson(url);
  if (data.status === 'error' || !Array.isArray(data.values)) throw new Error(data.message || 'Twelve Data pa retounen candles.');
  marketDataCache.set(cacheKey, { savedAt: Date.now(), values: data.values });
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
  let aiNoSignal = false;
  let aiProviderUsed = null;
  const prompt = `Ou se yon motè analiz PAPER TRADING edikatif. Pa egzekite okenn lòd reyèl.
Pair: XAUUSD
Timeframe: ${interval}
Candles: ${JSON.stringify(candleData)}
Si pa gen setup klè, retounen {"has_signal":false}. Sinon retounen sèlman yon objè JSON valab ak has_signal,type,entry_price,tp1,tp2,sl,session,risk_reward. Pa mete markdown ni eksplikasyon.`;

  for (const provider of aiProviders) {
    try {
      console.log(`[AI ROUTER] Trying ${provider.name} (${provider.model})`);
      const client = new OpenAI({
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        timeout: 20000,
        maxRetries: 0,
        defaultHeaders: provider.name === 'BazaarLink' ? { 'X-Free-Fallback': 'false' } : {}
      });
      const completion = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
      });
      const responseText = completion.choices?.[0]?.message?.content?.trim() || '';
      const clean = responseText.replace(/[\u0060]{3}json|[\u0060]{3}/g, '').trim();
      const parsed = JSON.parse(clean);
      aiProviderUsed = provider.name;

      if (parsed.has_signal === false) {
        aiNoSignal = true;
        console.log(`[AI ROUTER] ${provider.name} returned no signal; no fallback signal will be invented.`);
        break;
      }

      signal = normalizeAnalysis(parsed, interval);
      if (!signal) throw new Error('AI response did not contain a valid, complete signal.');
      signal.session = signal.session || `${provider.name} AI`;
      console.log(`[AI ROUTER] ${provider.name} analysis succeeded.`);
      break;
    } catch (err) {
      console.error(`[AI ROUTER] ${provider.name} failed; trying next provider:`, err.message);
    }
  }

  if (aiNoSignal) {
    return { success: true, message: `${aiProviderUsed} pa jwenn setup ki ase klè.`, signal: null, aiProvider: aiProviderUsed };
  }
  if (!signal) {
    console.warn('[AI ROUTER] All configured AI providers failed or no AI key is configured; using technical paper fallback.');
    signal = normalizeAnalysis(technicalPaperSignal(candleData), interval);
  }
  if (!signal) return { success: true, message: 'Pa gen setup ki ase klè.', signal: null, aiProvider: aiProviderUsed };
  return { success: true, signal: await saveSignal(signal), aiProvider: aiProviderUsed || 'Technical fallback' };
}

function calculatePnL(position, exitPrice) { return (exitPrice - position.entry_price) * (position.type === 'BUY' ? 1 : -1) * (position.units || 1000); }

async function openPaperPosition(signal) {
  const existing = paperAccount.positions.find(p => p.status === 'OPEN' && p.pair === signal.pair);
  if (existing) return { created: false, position: existing };
  const position = { id: `paper_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, pair: signal.pair, type: signal.type, entry_price: Number(signal.entry_price), tp1: Number(signal.tp1), tp2: signal.tp2 ? Number(signal.tp2) : null, sl: Number(signal.sl), timeframe: signal.timeframe, units: 1, openedAt: new Date().toISOString(), status: 'OPEN', unrealizedPnL: 0 };
  paperAccount.positions.push(position);
  try { await persistPaperState(); } catch (err) { console.error('[SUPABASE SAVE POSITION]', err.message); }
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
  try { await persistPaperState(); } catch (err) { console.error('[SUPABASE SAVE PAPER STATE]', err.message); }
  return getPaperState();
}

function getPaperState() {
  const openPositions = paperAccount.positions.filter(p => p.status === 'OPEN');
  paperAccount.equity = paperAccount.balance + openPositions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
  return { mode: TRADING_MODE, initialBalance: paperAccount.initialBalance, balance: Number(paperAccount.balance.toFixed(2)), equity: Number(paperAccount.equity.toFixed(2)), realizedPnL: Number(paperAccount.realizedPnL.toFixed(2)), openPositions, trades: paperAccount.trades.slice(-50).reverse(), lastResetAt: paperAccount.lastResetAt };
}

app.get('/api/health', (req,res) => res.json({ ok:true, mode:TRADING_MODE, service:'HIV3 Paper Trading Engine', supabaseConfigured:Boolean(supabase), persistenceReady, botEnabled:botControl.enabled, startingBalance:paperAccount.initialBalance, marketDataConfigured:Boolean(TWELVE_DATA_KEY), aiConfigured:Boolean(aiProviders.length), aiProvidersConfigured:aiProviders.map(provider => provider.name), marketDataCacheSeconds:MARKET_DATA_CACHE_MS/1000, realTradingEnabled:false, timestamp:new Date().toISOString() }));
app.get('/api/market-data/status', async (req,res) => {
  if (!TWELVE_DATA_KEY) return res.status(503).json({ ok:false, configured:false, provider:'Twelve Data', error:'TWELVE_DATA_API_KEY pa konfigire sou Render.', realTradingEnabled:false });
  try {
    const candles = await getMarketData('XAUUSD','5min',2);
    const latest = candles[0];
    if (!latest || !Number.isFinite(Number(latest.close))) throw new Error('Twelve Data pa retounen yon pri XAU/USD ki valab.');
    botControl.lastPrice = Number(latest.close);
    botControl.lastMarketAt = latest.datetime || new Date().toISOString();
    return res.json({ ok:true, configured:true, provider:'Twelve Data', symbol:'XAU/USD', price:botControl.lastPrice, marketTime:botControl.lastMarketAt, interval:'5min', cacheSeconds:MARKET_DATA_CACHE_MS/1000, realTradingEnabled:false });
  } catch (err) {
    console.error('[MARKET DATA STATUS]', err.message);
    return res.status(502).json({ ok:false, configured:true, provider:'Twelve Data', error:err.message, realTradingEnabled:false });
  }
});
// Read-only BiQuote market-data probe. This endpoint does not create signals or paper positions.
const biquoteCache = { savedAt: 0, payload: null };
const BIQUOTE_CACHE_MS = 15000;

app.get('/api/biquote/market-data', async (req, res) => {
  if (biquoteCache.payload && Date.now() - biquoteCache.savedAt < BIQUOTE_CACHE_MS) {
    return res.json({ ...biquoteCache.payload, cached: true, cacheAgeMs: Date.now() - biquoteCache.savedAt });
  }
  try {
    const [tick, candles] = await Promise.all([
      fetchJson('https://biquote.io/api/XAUUSD'),
      fetchJson('https://biquote.io/api/XAUUSD/ohlc?interval=5m&limit=30')
    ]);
    const payload = {
      ok: true,
      provider: 'BiQuote',
      symbol: 'XAU/USD',
      readOnly: true,
      retrievedAt: new Date().toISOString(),
      tick,
      candles
    };
    biquoteCache.savedAt = Date.now();
    biquoteCache.payload = payload;
    return res.json({ ...payload, cached: false, cacheAgeMs: 0 });
  } catch (err) {
    console.error('[BIQUOTE READ-ONLY DATA ERROR]', err.message);
    return res.status(502).json({
      ok: false,
      provider: 'BiQuote',
      symbol: 'XAU/USD',
      readOnly: true,
      error: err.message,
      retrievedAt: new Date().toISOString()
    });
  }
});

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
app.post('/api/bot/toggle',async(req,res)=>{
  const desired=req.body?.enabled===true;
  if(supabase) {
    try {
      await persistBotEnabled(desired); botControl.enabled=desired;
      botControl.lastMessage=desired?'Bot la aktive; eta a sove nan Supabase.':'Bot la OFF; eta OFF la sove nan Supabase.';
      return res.json({enabled:botControl.enabled,persisted:true,mode:TRADING_MODE,symbol:'XAUUSD',message:botControl.lastMessage});
    } catch(err) {
      botControl.enabled=false; botControl.lastMessage='Bot OFF: eta a pa t kapab sove nan Supabase.';
      console.error('[SUPABASE SAVE BOT STATE]',err.message);
      return res.status(503).json({enabled:false,persisted:false,message:botControl.lastMessage});
    }
  }
  botControl.enabled=false; botControl.lastMessage='Bot OFF: Supabase pa konekte, eta a pa ka sove.';
  return res.status(503).json({enabled:false,persisted:false,message:botControl.lastMessage});
});
app.get('/api/config',(req,res)=>res.json({mode:TRADING_MODE,realTradingEnabled:false,supportedSymbols:['XAUUSD'],timeframes:['1min','5min']}));
app.get('/api/analyze/:symbol',async(req,res)=>{if(!botControl.enabled)return res.status(423).json({success:false,error:'Bot la OFF.'});try{const result=await analyzeMarket('XAUUSD',req.query.interval||'5min');if(result.signal) await openPaperPosition(result.signal);res.json(result);}catch(err){console.error('[ANALYZE ERROR]',err.message);res.status(500).json({success:false,error:err.message});}});
app.get('/api/paper/state',async(req,res)=>{try{await updatePaperPositions();res.json(getPaperState());}catch(err){res.status(500).json({error:err.message,...getPaperState()});}});
app.post('/api/paper/refresh',async(req,res)=>{try{res.json(await updatePaperPositions(req.body?.symbol?.toUpperCase()));}catch(err){res.status(500).json({error:err.message,...getPaperState()});}});
app.post('/api/paper/reset',async(req,res)=>{
  paperAccount.initialBalance=STARTING_BALANCE; paperAccount.balance=STARTING_BALANCE;
  paperAccount.equity=STARTING_BALANCE; paperAccount.realizedPnL=0; paperAccount.positions=[];
  paperAccount.trades=[]; paperAccount.lastResetAt=new Date().toISOString(); signalHistory.length=0;
  try {
    if(supabase) { const {error}=await supabase.from('paper_positions').delete().neq('id',''); if(error) throw error; await persistPaperState(); }
    return res.json({...getPaperState(),persisted:Boolean(supabase)});
  } catch(err) {
    console.error('[SUPABASE RESET ERROR]',err.message);
    return res.status(503).json({error:'Reset la pa t kapab sove nan Supabase.',...getPaperState(),persisted:false});
  }
});

async function startServer() {
  await initializePersistentState();
  cron.schedule('*/5 * * * *',async()=>{
    if(!botControl.enabled) return console.log('[PAPER CRON] Bot OFF — scan skipped.');
    console.log('[PAPER CRON] Automatic XAUUSD analysis...');
    try {
      const result=await analyzeMarket('XAUUSD','5min');
      if(result.signal) await openPaperPosition(result.signal);
      await updatePaperPositions('XAUUSD');
      console.log('[PAPER CRON] Cycle complete:',getPaperState().balance,getPaperState().equity);
    } catch(err) { console.error('[PAPER CRON ERROR]',err.message); }
  });
  app.listen(PORT,()=>console.log('HIV3 Paper Trading API running on port '+PORT+'. PAPER MODE. Real trading: DISABLED. Starting balance: $'+STARTING_BALANCE+'. Bot enabled: '+botControl.enabled+'.'));
}
startServer();
