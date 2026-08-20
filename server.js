const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Supabase Credentials
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Endpoint pou resevwa Webhook Siyal (e.g. soti nan TradingView)
app.post('/api/webhook/signal', async (req, res) => {
    try {
        const { pair, category, type, entry_price, tp1, tp1_pips, tp2, tp2_pips, sl, sl_pips, timeframe, session, risk_reward } = req.body;

        const { data, error } = await supabase
            .from('signals')
            .insert([{
                pair,
                category,
                type,
                entry_price,
                tp1,
                tp1_pips,
                tp2,
                tp2_pips,
                sl,
                sl_pips,
                timeframe,
                session,
                risk_reward,
                status: 'ACTIVE'
            }]);

        if (error) throw error;

        return res.status(200).json({ success: true, message: 'Siyal anregistre ak siksè!', data });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sèvè a ap kouri sou port ${PORT}`));