# Neon Market: Themed Shops for Cyberpunk RED

Full-screen, themed shop encounters for the **Cyberpunk RED - CORE** system on Foundry VTT.
Put a clerk on stage, stock the shelves by drag and drop, and let players buy, sell and buy back
with eurobucks that land in the CPR wealth ledger.

| Requirement | Version |
| --- | --- |
| Foundry VTT | v12 (built with v13+ APIs in mind, see below) |
| Cyberpunk RED - CORE | 0.92 (verified against 0.92.4 source) |

![Character layout themes](docs/themes-character.png)
![Grid layout themes](docs/themes-grid.png)

## Install

**From a manifest URL (recommended, gets automatic updates):** in Foundry's setup screen open
*Add-on Modules*, click *Install Module*, paste the manifest URL from the project's release page
and click *Install*. See [PUBLISHING.md](PUBLISHING.md) for the URL format.

**By hand:** unzip `module.zip` into your Foundry `Data/modules/cpr-neon-market/` folder, so you
end up with `Data/modules/cpr-neon-market/module.json`.

Then open your world and enable **Neon Market** in *Manage Modules*.

## Set up a shop (GM)

1. Open shop settings from any of these:
   - the **Shop** button in an actor sheet header,
   - right-click the actor in the Actors sidebar, then **Shop settings**,
   - the sliders button in the Token HUD.
2. **Identity:** tick *Open for business*, name the shop and clerk, pick clerk art (a tall
   transparent portrait works best) and write what the clerk says.
3. **Look:** choose a theme. New shops start on **Night City chrome**, the look of
   [Neon Hub](https://github.com/choccoops/neonredlanding)'s calendar. Picking a theme also sets its layout and colors;
   change them afterwards if you like.
4. **Catalog:** drag items or item folders from the sidebar or a compendium onto a category.
   Leave *Price* blank to use the item's market price. *Stock* -1 means unlimited.
   *Copy this actor's items* turns the actor's own inventory into a category with matching stock.
5. **Audio / Trading:** music, sound effects, sell rate, buyback and shop cash.
6. Click **Preview** to see changes live while you edit, then **Save**.

Any actor can host a shop: an NPC, a container, even a player character. The shop catalog is
separate from the actor's own inventory and wallet.

## Open a shop

- **Players:** select your token, walk it next to the shopkeeper and press **G**
  (change the key in *Configure Controls*; set the distance in module settings).
- **GM:** Token HUD store button, or the bullhorn button to **show the shop on every player's screen**.
- **Macro / API:**

```js
const api = game.modules.get("cpr-neon-market").api;
api.open(actorOrUuid);            // open for yourself
api.present(actorOrUuid);         // GM: open on all players' screens
api.present(actorOrUuid, [userId]); // GM: only these users
api.dismiss(actorOrUuid);         // GM: close it everywhere
api.configure(actorOrUuid);       // GM: open the editor
await api.getShop(actorOrUuid);   // read the shop config
```

## How trades work

Players can't write to an NPC they don't own, so every trade is sent to the active GM's client,
which checks prices and stock itself (it never trusts the player's numbers), then:

1. takes or pays eurobucks through the CPR ledger,
2. adds or removes the items (stackables like ammo merge into existing stacks),
3. updates stock, buyback list and shop cash.

If any step fails, the earlier steps are undone, so a trade never half-happens. Requests are
processed one at a time, so two players can't both buy the last item.
**A GM must be logged in for players to trade.**

### Prices, the Cyberpunk RED way

Prices follow the system's own container shop, which follows the core rulebook (p.344):

- Ammunition other than grenades and rockets is priced **per 10 rounds**. A compendium box of
  10 Basic Arrows (market 10eb) sells for 10eb. A box of 50 you set up yourself would sell for 50eb.
- Everything else is priced per piece. A listing's price is for one purchase of the item as listed,
  so a listing with amount 3 sells three at a time.
- When characters sell, they pick how many rounds or pieces to sell. The payout is
  `market price per unit x units x sell rate`, rounded down.

### Shop cash

| Mode | What happens |
| --- | --- |
| Unlimited | The shop always has cash to buy from characters. |
| Limited | Cash is tracked in the shop settings. Sales to characters refill it. |
| This actor's own eurobucks | Uses the host actor's CPR wallet and records every trade in its ledger. Available for characters and containers. |

### Cyberpunk RED container vendors

If the host actor is a CPR container, its vendor settings still apply:

- item types it isn't buying are hidden from the Sell tab;
- its per-type buy percentage is used when neither the item listing nor the shop sets a sell rate.

### Upgrades and loaded weapons

Items keep their installed upgrades when they're bought, sold or bought back. This uses the same
install tree (`flags.cprInstallTree`) the system uses when you drag items between sheets.
Loaded ammunition never comes along. A loaded weapon is unloaded before it's sold, and the
rounds go back to the seller's ammo.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Default sell rate | 50% | Share of market price shops pay; shops and items can override it. |
| Players can sell to shops | On | Off makes every shop buy-only. |
| GM approves every trade | Off | Player trades wait for a GM confirmation. |
| Interaction range | 4 | Distance in scene units for the G key and HUD button. 0 = anywhere. |
| Chat receipts | Private | Public, GM + owners only, or none. |
| Show price categories | On | Cheap, Everyday, Costly and so on, from the core book. |
| Scene music while shopping | 20% | Client setting: playlist volume while a shop is open. |

## Cyberpunk RED data this module relies on

Verified against the v0.92.4 source. All paths are checked before use, so a system update that
renames one degrades to "no data" rather than breaking a trade. After a system update, check these first.

| Data | Where | Notes |
| --- | --- | --- |
| Wallet | `system.wealth.value`, `system.wealth.transactions` | Characters and containers only (WealthSchema). Mooks have none. |
| Ledger entry | `[CPR.ledger.increaseSentence / decreaseSentence, "reason - user"]` | Same format as `CPRActor.deltaLedgerProperty`, but awaited. |
| Price | `system.price.market` | ValuableSchema, integer. |
| Per-10 pricing | `type === "ammo"`, `system.variety` not `grenade` or `rocket` | Mirrors `CPRContainerSheet`. |
| Stack size | `system.amount` | StackableSchema: ammo, clothing, drug, gear. |
| Installed state | `system.isInstalled` (getter), `system.installedItems.list` | Installed items can't be sold on their own. |
| Upgrades | `flags.cprInstallTree`, `createInstalledObjectData()`, `recursiveGetAllInstalledItems()` | Rebuilt by `CPRActor.createEmbeddedDocuments`. |
| Loaded ammo | `system.hasAmmoLoaded`, `item.unload()` | Unloaded before sale. |
| Core items | `system.core` | Never listed; CPR refuses to add them to actors. |
| Vendor settings | `system.vendor.itemTypes.<type>.isPurchasing / purchasePercentage` | Container actors. |

## Forward compatibility (Foundry v13+)

- Both windows use **ApplicationV2**, the framework v13+ is built on.
- `scripts/compat.js` resolves APIs that move into `foundry.*` namespaces in v13
  (FilePicker, TextEditor, AudioHelper, renderTemplate, loadTemplates) and falls back to the v12 globals.
- Hooks are registered for both v12 (Application v1) and v13 (Application v2) sheet headers,
  directory context menus and the Token HUD.
- `module.json` declares v12 as verified with no maximum, so Foundry will allow it on v13 with a
  warning. Once the CPR team publishes their v13 release, test there and bump `verified`.

## Known limits

- Tested with static renders of the UI, not yet in a live Foundry world. Try it on a copy first.
- Item Piles and the system's own container shops are separate systems; don't run the same actor through both.
- The editor is GM-only.

## License

MIT. Bundles the Tektur font (SIL Open Font License, see `fonts/Tektur-OFL.txt`).
Cyberpunk RED is a trademark of R. Talsorian Games; this is unofficial fan content.

## Updates

Every release and what changed is listed in [CHANGELOG.md](CHANGELOG.md) and on the project's
Releases page. Maintainers: see [PUBLISHING.md](PUBLISHING.md).
