# HIV3 Paper Trading Bot

This version keeps the TRADEX theme but changes the product into a paper-trading laboratory.

## Current mode

- PAPER TRADING ONLY
- Starting virtual balance: $100
- AI market analysis remains enabled when the required API keys are configured.
- Signals can open virtual positions.
- Virtual positions are monitored with market data and can close at TP/SL.
- No broker order API exists in this version.
- No real-money execution is enabled.

## Backend environment variables

Set these on the backend host:

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- BAZAARLINK_API_KEY
- TWELVE_DATA_API_KEY

The frontend only uses the public Supabase anon key that was already part of the existing site. Never expose the Supabase service-role key or any broker credentials in the frontend.

## API

- GET /api/health
- GET /api/config
- GET /api/analyze/:symbol?interval=5min
- GET /api/paper/state
- POST /api/paper/refresh
- POST /api/paper/reset

## Important

The paper account is held in server memory, so a Render restart resets the virtual account. A later persistence layer can store paper trades in Supabase if desired.
