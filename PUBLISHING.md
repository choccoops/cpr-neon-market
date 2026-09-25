# Publishing and updating Neon Market

The repo builds its own releases. You write code and the changelog; pushing a version tag
publishes a `module.json` and `module.zip` that Foundry can install and update from.

## First-time setup

Create an **empty, public** repository (no README or license, since this repo already has them).
The project has to be public so Foundry can download from it.

**GitHub**

```bash
git remote add origin https://github.com/YOUR-NAME/cpr-neon-market.git
git push -u origin main --tags
```

**GitLab**

```bash
git remote add origin https://gitlab.com/YOUR-NAME/cpr-neon-market.git
git push -u origin main --tags
```

Pushing the `v1.1.0` tag runs the first release. Check the **Actions** tab (GitHub) or
**Build > Pipelines** (GitLab); when it's green, the release page has both files.

**Manifest URL to give players and to paste into Foundry's Install Module box:**

- GitHub: `https://github.com/YOUR-NAME/cpr-neon-market/releases/latest/download/module.json`
- GitLab: `https://gitlab.com/YOUR-NAME/cpr-neon-market/-/releases/permalink/latest/downloads/module.json`

Install from that URL once (replacing any copy you unzipped by hand). From then on,
Foundry's **Check for Updates** picks up every new release.

## Releasing an update

1. Make your changes.
2. Add a section to the top of `CHANGELOG.md`, headed with the new version exactly like this:
   `## 1.2.0`. That section becomes the release notes.
3. Set `"version"` in `module.json` to the same number.
4. Commit, tag and push:

```bash
git add -A
git commit -m "Release 1.2.0"
git tag v1.2.0
git push && git push --tags
```

The build checks every script for syntax errors and fails the release if one is broken,
so a bad update never reaches your players.

## Version numbers

- `1.1.1`: bug fixes only
- `1.2.0`: new features that don't break existing shops
- `2.0.0`: changes that need GMs to redo shop settings

## Moving to Foundry v13

When the Cyberpunk RED team releases their v13 system, test the module there, then set
`"compatibility": { "minimum": "12", "verified": "13" }` in `module.json` and release as usual.
The CPR data fields the module relies on are listed in the README; re-check those against
the new system version first.
