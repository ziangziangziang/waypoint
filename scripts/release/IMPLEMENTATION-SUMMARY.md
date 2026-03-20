# Waypoint v0.6.0 Release - Implementation Summary

## ✅ Completed Tasks

### 1. Version Updates
- [x] `package.json`: 0.5.3 → 0.6.0
- [x] `ui/package.json`: 0.5.3 → 0.6.0
- [x] `src/mcp/service.ts`: MCP server version 0.5.3 → 0.6.0

### 2. Changelog
- [x] Added v0.6.0 section to `CHANGELOG.md` with:
  - Built-in MCP service details
  - Agent Mode feature
  - Tool Picker and visualization
  - Token Flow Sankey
  - File-first policy changes

### 3. README Updates
- [x] Added screenshot placeholders for:
  - `assets/mcp-generate-image.png`
  - `assets/mcp-understand-image.png`
  - `assets/peek-token-flow.png`

### 4. GitHub Actions
- [x] Created `.github/workflows/release.yml`:
  - Triggers on tag push `v*.*.*`
  - Builds project
  - Extracts changelog for version
  - Creates GitHub release automatically

### 5. Screenshot Automation
- [x] Created `scripts/capture-screenshots.js`:
  - Playwright-based screenshot capture
  - Captures 3 required screenshots
  - Outputs to `assets/` directory

### 6. Release Content
- [x] `scripts/release/github-release-body.md` - English release
- [x] `scripts/release/github-release-body-zh.md` - Chinese release
- [x] `scripts/release/reddit-post.md` - Reddit post draft
- [x] `scripts/release/PRE-RELEASE-CHECKLIST.md` - Complete checklist

## 📋 Next Steps (Manual)

### Immediate
1. **Capture screenshots** (requires running server with models):
   ```bash
   npm install -D @playwright/test
   npx playwright install
   npm run dev  # in one terminal
   node scripts/capture-screenshots.js  # in another
   ```

2. **Review and test**:
   ```bash
   npm run build:all
   npm run start
   # Test MCP tools in playground at http://localhost:8000/ui
   ```

3. **Commit changes**:
   ```bash
   git add .
   git commit -m "chore: prepare v0.6.0 release with MCP tools"
   git push origin dev
   ```

4. **Create and push tag**:
   ```bash
   git tag v0.6.0
   git push origin v0.6.0
   ```

### Post-Tag
5. **GitHub Actions will auto-create release** - Review and edit if needed

6. **Post to Reddit** - Copy from `scripts/release/reddit-post.md`

## 📁 Files Created/Modified

### Modified
- `package.json`
- `ui/package.json`
- `src/mcp/service.ts`
- `CHANGELOG.md`
- `README.md`

### Created
- `.github/workflows/release.yml`
- `scripts/capture-screenshots.js`
- `scripts/release/github-release-body.md`
- `scripts/release/github-release-body-zh.md`
- `scripts/release/reddit-post.md`
- `scripts/release/PRE-RELEASE-CHECKLIST.md`

## 🎯 Release Highlights

### Core Selling Points
1. **Built-in MCP Service** (`POST /mcp`)
   - `generate_image` - File-first image generation
   - `understand_image` - Vision-based analysis

2. **Agent Mode**
   - Toggle to enable tool-calling workflows
   - Tool Picker for selecting MCP tools
   - Up to 10 iterations per message

3. **Token Flow Sankey**
   - Visual token attribution in Peek

4. **Existing Features**
   - OpenAI-compatible proxy
   - Health-based failover
   - Provider-first architecture
   - Real-time dashboard

## 🚀 Release URLs

- GitHub Release: https://github.com/zziang/waypoint/releases/tag/v0.6.0
- Reddit Post: https://www.reddit.com/r/LocalLLaMA/
- Documentation: https://github.com/zziang/waypoint#readme

## 📊 Metrics to Track

After release:
- GitHub stars/watchers growth
- Reddit upvotes/comments
- Issue/PR activity
- Download/clone stats

---

**Status:** Ready for manual screenshot capture and release
**Date:** 2026-03-20
**Version:** 0.6.0
