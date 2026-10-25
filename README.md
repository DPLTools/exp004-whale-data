# exp004-whale-data

Daily list of BTC-active Hyperliquid wallets for the EXP-004 BTC Whale Monitor app.

- `data/btc-traders.json` is rebuilt every day at 00:20 UTC by GitHub Actions (`.github/workflows/build-list.yml`).
- The job (`server/build-list.mjs`) reads the public Hyperliquid leaderboard, takes accounts worth at least $100,000 with
  monthly volume at most 200 times their value, largest first (up to 1,500), reads every fill of the last 30 days, and
  keeps wallets with at least 20 BTC fills on 5 or more UTC days and a BTC share of at least 30%.
- The app reads the file from `https://raw.githubusercontent.com/DPLTools/exp004-whale-data/main/data/btc-traders.json`
  and only fetches live positions itself.

This is a selection of active public wallets, not a ranking of skill and not trading advice. All data is public.
