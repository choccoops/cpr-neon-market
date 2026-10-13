# Changelog

## 1.4.0

Tech shops: repairs, upgrades, fabrication and invention.

- **Tech shops.** Any actor can be a Tech's shop, alongside a clinic and a store. Customers book jobs; the GM's client rolls the Tech's check (repair skill + Maker rank + 1d10 against the book's DV), charges labor and materials, applies the result and posts a card.
- **Repairs** at the Core Rulebook's DVs by price category, or by damage for vehicles. With Neon At Home, Damaged, Destroyed and malfunctioning gear is listed and set working again through its API; armor gets its SP and shield HP back.
- **MMuton's Vehicle Actor Sheet.** A customer's vehicles can be repaired (SDP, plating, bulletproof glass, vehicle critical injuries) and upgraded, and the damaged weapons and upgrades mounted on them repaired.
- **Upgrades** from the book's list, one per item: lower Humanity Loss on cyberware, extra slots, Excellent Quality, concealable, +1 SP and Simplify are applied; the rest are recorded for the GM.
- **Fabrication** from blueprints the GM drags in, at one price category lower in materials; **invention** pitches the GM prices, which become blueprints.
- Failed jobs cost nothing by default, as the Tech starts over. Labor fees are editable; materials follow the book.
- Store, clinic and tech shop windows link to each other. API: `openTech`, `configureTech`, `getTech`, `setTech`.
- **Less clutter.** One Neon Market button in actor sheet headers, one entry in the Actors sidebar menu and one sliders button in the Token HUD, each asking whether you want the store, clinic or tech shop settings and showing which are open. The Token HUD has a single open button too, for the actor's clinic, tech shop or store, whichever it has first. The HUD buttons are now GM-only; players use the interact key, which only reaches NPC actors (none owned by a player).
- Under the hood: clinics and tech shops share one booking runner and chat card; tests now live in the repo and run before every release.

## 1.3.0

Ripperdoc clinics and hospitals.

- **Clinics.** Any actor can be a ripperdoc clinic or hospital, alongside its shop or on its own. Patients book procedures; the GM's client rolls the doctor's check, charges the fee and applies the result, with a chat card for each.
- **Healing, per the Core Rulebook.** Stabilization by wound state, Quick Fixes and Treatments for each critical injury at the DVs on the injury (Cybertech for injuries to cyberware), hospital beds and cryotanks that heal by BODY each day, and Humanity and addiction therapy. Quick Fixes wear off when the world clock passes into the next day.
- **Cyberware installation.** Bring your own cyberware; the facility installs it if it's at or below its level (Mall, Clinic, Hospital), using CPR's own install and Humanity Loss rolls. A failed surgery can destroy the cyberware, as in the book.
- **Fees** default to the rulebook's prices, are all editable, and can be 0 for free work. They can be paid into the clinic actor's eurobucks. HP and Humanity changes are recorded in the character's CPR ledgers.
- The clinic links to the same actor's store and back; the G key opens the clinic when an actor has one. API: `openClinic`, `configureClinic`, `getClinic`, `setClinic`.

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
