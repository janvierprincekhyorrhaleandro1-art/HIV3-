const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const OpenAI = require('openai');

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

// 3. Fonksyon pou rale 10 dènye bouji 5 MINIT (Lò oswa Forex)
async function getMarketData(symbol) {
    let formattedSymbol = symbol;

    // Fòmate 'XAUUSD' kòm 'XAU/USD' oswa 'EURUSD' kòm 'EUR/USD' pou Twelve Data API
    if (!symbol.includes('/')) {
        formattedSymbol = symbol.slice(0, 3) + '/' + symbol.slice(3);
    }

    const url = `https://api.twelvedata.com/time_series?symbol=${formattedSymbol}&interval=5min&outputsize=10&apikey=${TWELVE_DATA_KEY}`;

    const response = await fetch(url);
    const data = await response.json();
    return data.values;
}

// 4. Endpoint pou deklanche analiz la sou demann (lè yo peze bouton sou sit la)
app.get('/api/analyze/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();

        // Rale done 5 minit yo sou Twelve Data
        const candleData = await getMarketData(symbol);

        if (!candleData) {
            return res.status(400).json({
              success: false,
              error: "Echèk nan rale done 5mn yo nan Twelve Data."
            });
        }

        // Rekonèt otomatikman si se Lò (GOLD) oswa FOREX
        const category = symbol.includes('XAU') || symbol.includes('GOLD') ? 'GOLD' : 'FOREX';

        // Prepare Prompt pou BazaarLink AI
        const prompt = `
          Ou se yon motè algoritmik pou mache Forex ak Lò.
          Men 10 dènye bouji M5 (5 minit) pou ${symbol}:
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
            "timeframe": "5m",
            "session": "Live Market",
            "risk_reward": "1:2"
          }
        `;

        // Voye done yo bay BazaarLink AI
        const completion = await bazaarlink.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
        });

        const responseText = completion.choices[0].message.content.trim();
        const cleanJson = responseText.replace(/```json|```/g, '').trim();
        const analysis = JSON.parse(cleanJson);

        // Si BazaarLink jwenn siyal, anregistre l nan Supabase
        if (analysis.has_signal) {
            delete analysis.has_signal;

            const { data: dbData, error } = await supabase
                .from('signals')
                .insert([{ ...analysis, status: 'ACTIVE' }]);

            if (error) throw error;

            return res.status(200).json({
              success: true,
              message: 'Nouvo siyal detekte epi save ak siksè!',
              signal: analysis
            });
        }

        return res.status(200).json({
          success: true,
          message: 'Pa gen okenn siyal sou 5mn pou kounye a.'
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sèvè a ap kouri sou port ${PORT}`));