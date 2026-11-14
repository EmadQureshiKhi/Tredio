# Roadmap

Tredio runs whole on NEAR testnet today, and the code is ready for mainnet ([MAINNET.md](MAINNET.md)).
This page is the order of work from here: what changes before the mainnet launch, and what comes after it.
Each item names where it stands now, so nothing here is a surprise to a reader of [JUDGES.md](JUDGES.md) or [SECURITY.md](SECURITY.md).

## Before mainnet

1. **Independent audit, then keys.**
   The contracts have a self-audit ([contracts/AUDIT.md](contracts/AUDIT.md)), Rustle, Clippy security lints and `cargo deny`; an audit firm reviews them next.
   The full-access keys the testnet contract accounts keep for redeploys are removed or moved behind a timelocked multisig, and M-4 (trading against an index whose next value can be known first) gets a trading-design answer rather than only the clamp and the band that bound it today.
2. **Index calibration.**
   Testnet's saturation levels suit mid-size topics, so the biggest ones read 100 and their charts go flat (the app marks them "At the cap").
   The mainnet enclave build, a new hash in any case, recalibrates the levels from testnet's readings so the largest topics keep moving on the way up.
3. **Paid data, fresher readings.**
   Testnet runs the attention sources on free tiers, so some readings refresh slowly; the oracle leaves any reading past its window out of the blend and the app marks it "Stale".
   Mainnet runs paid plans, and the keyed collectors (Elfa, Nansen) move inside the enclave with OutLayer secrets, so every reading is attested, not only the blend.
4. **Operators that persist.**
   The relayer's sign-up and funding budgets live in memory and reset on a restart, harmless on testnet; they move to Postgres before launch.
5. **Settlement across chains.**
   NEAR Intents 1Click deposits and the return route settle only on mainnet, so their first live runs are part of the launch checklist; Autopilot's mainnet policy wallets go live with the partner key.
6. **Honest screens.**
   Activity accounts the team runs get a mark in the app, as they are already disclosed in JUDGES.md.

## After launch

- **More than one operator.**
  A set of enclave oracle keys and open keepers, so no single service of the team's can pause the index or the markets.
- **More attention.**
  Further sources (video, forums, more languages) behind the same log-scale method, each attested in the enclave.
- **More for agents.**
  More x402 resources (order flow, settlement feeds), delivered jobs on the NEAR AI Agent Market, and the trade tools of the MCP server under per-agent policies.
- **Native apps.**
  The push notifications and attention alerts the web app sends today, in native mobile apps with passkeys.
