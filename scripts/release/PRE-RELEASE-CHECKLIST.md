# Waypoint v0.6.0 Pre-Release Checklist

## ✅ Completed

- [x] Updated `package.json` version to 0.6.0
- [x] Updated `ui/package.json` version to 0.6.0
- [x] Updated `src/mcp/service.ts` MCP server version to 0.6.0
- [x] Updated `CHANGELOG.md` with v0.6.0 release notes
- [x] Updated `README.md` with new screenshot placeholders
- [x] Created `.github/workflows/release.yml` for automated releases
- [x] Created `scripts/capture-screenshots.js` for screenshot automation
- [x] Created release content drafts (English + Chinese)
- [x] Created Reddit post draft

## ⏳ Remaining (Manual Steps)

### 1. Capture New Screenshots

**Prerequisites:**
- Start server: `npm run dev` or `npm run start`
- Configure at least one diffusion model (for `generate_image`)
- Configure at least one vision model (for `understand_image`)
- Generate some chat requests for Peek data

**Steps:**
```bash
# Install Playwright
npm install -D @playwright/test
npx playwright install

# Run screenshot capture
node scripts/capture-screenshots.js
```

**Expected output files:**
- `assets/mcp-generate-image.png`
- `assets/mcp-understand-image.png`
- `assets/peek-token-flow.png`

**Note:** The automated script captures basic screenshots. For better quality showing actual MCP tool usage, you may want to manually:
1. Navigate to `/ui/playground`
2. Enable Agent Mode
3. Select `generate_image` or `understand_image` tools
4. Execute a tool call
5. Take screenshot with system screenshot tool

### 2. Build and Test

```bash
# Build everything
npm run build:all

# Test MCP tools manually
# 1. Start server
npm run start

# 2. Open playground
# Visit http://localhost:8000/ui

# 3. Test agent mode with MCP tools
# - Enable Agent Mode
# - Select tools
# - Execute tool calls
```

### 3. Create Git Tag and Push

```bash
# Create tag
git tag v0.6.0

# Push tag (triggers GitHub Actions)
git push origin v0.6.0
```

### 4. Create GitHub Release

**Option A: Automatic (via GitHub Actions)**
- Tag push will automatically create release with changelog
- Review and edit release if needed

**Option B: Manual**
1. Go to https://github.com/zziang/waypoint/releases/new
2. Tag: `v0.6.0`
3. Title: `Waypoint v0.6.0`
4. Description: Copy from `scripts/release/github-release-body.md`
5. Upload screenshots as assets (optional)
6. Publish release

### 5. Post to Reddit

1. Copy content from `scripts/release/reddit-post.md`
2. Navigate to https://www.reddit.com/r/LocalLLaMA/
3. Create new post
4. Title: From reddit-post.md
5. Body: From reddit-post.md
6. Upload screenshots as images (not links)
7. Submit

### 6. Verify Release

- [ ] GitHub release page looks good
- [ ] All screenshots display correctly
- [ ] Links work
- [ ] Reddit post is live
- [ ] Build passes on GitHub Actions

## Release Content Files

- `scripts/release/github-release-body.md` - English GitHub release
- `scripts/release/github-release-body-zh.md` - Chinese GitHub release
- `scripts/release/reddit-post.md` - Reddit post for r/LocalLLaMA

## Rollback Plan

If issues are found after release:

```bash
# Revert tag
git tag -d v0.6.0
git push origin :refs/tags/v0.6.0

# Create patch version
git tag v0.6.1
git push origin v0.6.1
```
