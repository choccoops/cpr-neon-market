# Changelog

## 1.2.3

- **Fixed: browse buttons in the shop editor did nothing on Foundry v12.** Neon Market looked up v12's FilePicker and TextEditor in a way that only works in v13 (the same fix as Neon Hub 1.3.1). This also fixes dragging items into a catalog and showing item descriptions in the shop, and works with The Forge's file picker.

## 1.2.2

- Fixed: shops wouldn't open at all ("setting getter-only property state"). The shop window kept its data in a property name Foundry reserves for every window.
- Fixed: the shop editor's tabs didn't switch ("You must pass both the tab and tab group identifier"). The tab buttons used an action name Foundry handles itself.

## 1.2.1

- Fixed: "Left after paying" showed its amount in capitals ("950EB").
- Every scrolling pane in the shop has a thin scrollbar in the theme's color, instead of the browser's default (a bright white bar under the cart in some browsers).
- README screenshots show the 1.2 look, with a new one of the Night City chrome theme.

## 1.2.0

One look with Neon Hub: the market now wears the Neon Hub calendar's chrome.

- **Night City chrome theme.** Black chrome, notched panels with a neon edge, uppercase Tektur type, scanlines and a glitching shop name. It's the default for new shops; existing shops keep their theme.
- **Calendar styling everywhere.** Every theme gets Tektur labels, buttons and prices, notched buttons and cards, and `//` kickers. The data terminal stays all-monospace.
- **Shop editor and dialogs** get the calendar's title bar and black chrome forms, whatever the core UI theme.
- **Chat receipts** are calendar-style cards in the shop's main color.
- Bundles the Tektur font (SIL Open Font License).
- With reduced motion turned on, looping effects (the glitch, the terminal cursor) now stop instead of flickering.

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
