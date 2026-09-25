# Changelog

## 1.1.0

Checked line by line against the Cyberpunk RED - CORE v0.92.4 source.

- Fixed a double charge. CPR's `deltaLedgerProperty` doesn't wait for its own update, so the old fallback could apply a trade twice. Wallet changes now write the same ledger entry the system writes (`CPR.ledger.*` sentence, `reason - player name`) and wait for it.
- Prices now follow the system's rules. Ammo, except grenades and rockets, is priced per 10 rounds, and everything else per piece. A compendium box of arrows sells for its book price. The "Rounds per ammo box" setting is gone because the item's own amount decides it.
- Selling is now counted in rounds or pieces, not boxes. Characters can sell part of a stack.
- Weapons and armor keep their installed upgrades when bought, sold or bought back, using the system's own install tree. Loaded ammunition is never included. A loaded weapon is unloaded before sale, and the rounds go back to the seller.
- Selling an upgraded item takes its upgrades with it, and undoing a failed trade puts them all back.
- Core items (such as foundational cyberware) can't be listed or sold.
- New shop cash option: use the host actor's own eurobucks. Every trade is recorded in its CPR ledger, which works with container actors and characters.
- CPR container vendors: types the vendor isn't buying are hidden from the Sell tab, and its per-type buy percentages apply when the shop has no rate of its own.
- Stat panel fixes: cyberware install location, cyberdeck slots, program size, and localized weapon quality.
- Only characters appear as buyers; mooks have no wallet in CPR.

## 1.0.0

First release, for Foundry VTT v12 and Cyberpunk RED - CORE 0.92.

- Full-screen themed shop with two layouts (Character, Grid) and eight themes.
- GM shop editor with live preview, drag-and-drop catalog, per-item price, discount, stock, price category and sell-rate overrides, and inventory import.
- Buy (cart), sell and buyback, with optional limited shop cash.
- GM-mediated trades with full rollback; eurobucks recorded in the CPR wealth ledger.
- Optional GM approval for every trade; chat receipts (public, private or off).
- Interact key (G) near a shopkeeper, Token HUD buttons, sheet header button, actor context menu, "show shop to players".
- Per-shop background music and five sound-effect slots; scene music ducks while shopping.
