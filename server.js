const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const OpenAI = require('openai');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(cors());

// 1. Supabase Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2. BazaarLink AI Setup
const bazaarlink = new OpenAI({
  baseURL: 'https://api.bazaarlink.ai/v1',
  apiKey: process.env.BAZAARLINK_API_KEY,
});

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;

// 3. Fonksyon pou rale done Twelve Data
async function getMarketData(symbol, interval = '5min') {
    let formattedSymbol = symbol;

    if (!symbol.includes('/')) {
        formattedSymbol = symbol.slice(0, 3) + '/' + symbol.slice(3);
    }

    const url = `https://api.twelvedata.com/time_series?symbol=${formattedSymbol}&interval=${interval}&outputsize=10&apikey=${TWELVE_DATA_KEY}`;

    const response = await fetch(url);
    const data = await response.json();
    return data.values;
}

// 4. Filtre Volatilité (Anti-Gasi Token)
function hasMarketVolatility(symbol, candleData) {
    if (!candleData || candleData.length < 2) return false;

    const latestCandle = candleData[0];
    const high = parseFloat(latestCandle.high);
    const low = parseFloat(latestCandle.low);
    const candleSpread = Math.abs(high - low);

    const isGold = symbol.includes('XAU') || symbol.includes('GOLD');

    if (isGold) {
        return candleSpread >= 0.40; // Mwens pase $0.40 sou Lò = Mache mouri
    } else {
        return candleSpread >= 0.0004; // Mwens pase 4 pips sou Forex = Mache mouri
    }
}

// 5. Fonksyon prensipal pou fè analiz
async function runAnalysisTask(symbol, interval = '5min') {
    console.log(`\n========================================`);
    console.log(`⏰ AUTOMATION RUN: ${symbol} (${interval}) - ${new Date().toISOString()}`);
    console.log(`========================================`);

    try {
        // Step 1: Twelve Data
        console.log("1. Ap rale done Twelve Data...");
        const candleData = await getMarketData(symbol, interval);

        if (!candleData) {
            console.error("❌ ERÈ TWELVE DATA: Done yo pa disponib.");
            return { success: false, error: "Echèk done Twelve Data." };
        }

        // Step 2: Filtre Volatilité
        console.log("2. Kontwòl Volatilité...");
        if (!hasMarketVolatility(symbol, candleData)) {
            console.log(`⏸️ ${symbol} ap dormi. Pa gen vòl (BazaarLink AI sote).`);
            return { success: true, message: "Mache a kalm. Pa gen siyal." };
        }

        console.log("🔥 MOUVMAN DETEKTE! BazaarLink AI an aksyon...");

        const category = symbol.includes('XAU') || symbol.includes('GOLD') ? 'GOLD' : 'FOREX';

        const prompt = `
          Ou se yon motè algoritmik pou mache Forex ak Lò.
          Men 10 dènye bouji ${interval} pou ${symbol}:
          ${JSON.stringify(candleData)}

          Analize pri yo ak tandans lan.
          Si PA GEN opòtinite klè, reponn SÈLMAN: {"has_signal": false}

          Si GEN yon bon opòtinite BUY oswa SELL, reponn SÈLMAN ak JSON sa a:
          {
            "has_signal": true,
            "pair": "${symbol}",
            "category": "${category}",
            "type": "BUY" oswa "SELL",
            "entry_price": number,
            "tp1": number,
            "tp1_pips": number,
            "tp2": number,
            "tp2_pips": number,
            "sl": number,
            "sl_pips": number,
            "timeframe": "${interval}",
            "session": "Live Market",
            "risk_reward": "1:2"
          }
        `;

        // Step 3: BazaarLink AI
        const completion = await bazaarlink.chat.completions.create({
            model: "auto:free",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
        });

        const responseText = completion.choices[0].message.content.trim();
        const cleanJson = responseText.replace(/```json|```/g, '').trim();
        const analysis = JSON.parse(cleanJson);

        // Step 4: Supabase Insert
        if (analysis.has_signal) {
            console.log("🎯 NOUVO SIYAL DETEKTE! Ap save nan Supabase...");
            delete analysis.has_signal;

            const { error } = await supabase
                .from('signals')
                .insert([{ ...analysis, status: 'ACTIVE' }]);

            if (error) throw error;
            console.log("✅ Siyal save nan Supabase ak siksè!");

            return { success: true, signal: analysis };
        }

        console.log("ℹ️ BazaarLink di pa gen bon opòtinite an tan reyèl.");
        return { success: true, message: "Pa gen siyal." };

    } catch (err) {
        console.error("❌ ERÈ ANALIZ:", err.message);
        return { success: false, error: err.message };
    }
}

// 6. Endpoint pou deklanchman manyèl depi sou sit la
app.get('/api/analyze/:symbol', async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const interval = req.query.interval || '5min';
    const result = await runAnalysisTask(symbol, interval);
    return res.status(result.success ? 200 : 500).json(result);
});

// 7. INTERNAL CRON JOB (KOURI CHAK 7 MINIT SÈLMAN POU LÒ / XAUUSD)
//cron.schedule('*/7 * * * *', async () => {
    console.log("\n🚀 [CRON 7MN] Ekzekisyon analiz otomatik sou XAUUSD (Lò)...");
    await runAnalysisTask('XAUUSD', '5min');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Sèvè a ap kouri sou port ${PORT} ak CronJob 7mn (XAUUSD) aktive!`));
