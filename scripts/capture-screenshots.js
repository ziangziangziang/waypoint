#!/usr/bin/env node
/**
 * Screenshot capture script for Waypoint v0.6.0 release
 * 
 * Prerequisites:
 * - Server running at http://localhost:8000
 * - At least one diffusion model configured (for generate_image)
 * - At least one vision model configured (for understand_image)
 * - Sample request data in stats (for Peek Sankey)
 * 
 * Usage:
 *   npm install -D @playwright/test
 *   npx playwright install
 *   node scripts/capture-screenshots.js
 */

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:8000';
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// Ensure assets directory exists
if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

async function captureScreenshots() {
  console.log('Starting screenshot capture...');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Output: ${ASSETS_DIR}`);
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    
    // Test connectivity
    console.log('Testing connectivity...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 10000 });
    console.log('✓ Server is reachable');
    
    // Screenshot 1: MCP Image Generation
    console.log('\n1. Capturing MCP Image Generation...');
    try {
      await page.goto(`${BASE_URL}/ui/playground`, { waitUntil: 'networkidle' });
      
      // Wait for page to load
      await page.waitForSelector('button', { timeout: 5000 });
      
      // Take initial screenshot of playground with agent mode
      await page.screenshot({
        path: path.join(ASSETS_DIR, 'mcp-generate-image.png'),
        fullPage: false
      });
      console.log('   ✓ Captured mcp-generate-image.png');
    } catch (error) {
      console.log('   ⚠ Failed to capture MCP generate image:', error.message);
    }
    
    // Screenshot 2: MCP Image Understanding
    console.log('\n2. Capturing MCP Image Understanding...');
    try {
      await page.goto(`${BASE_URL}/ui/playground`, { waitUntil: 'networkidle' });
      
      // Wait for page to load
      await page.waitForSelector('button', { timeout: 5000 });
      
      await page.screenshot({
        path: path.join(ASSETS_DIR, 'mcp-understand-image.png'),
        fullPage: false
      });
      console.log('   ✓ Captured mcp-understand-image.png');
    } catch (error) {
      console.log('   ⚠ Failed to capture MCP understand image:', error.message);
    }
    
    // Screenshot 3: Peek Token Flow Sankey
    console.log('\n3. Capturing Peek Token Flow Sankey...');
    try {
      await page.goto(`${BASE_URL}/ui/peek`, { waitUntil: 'networkidle' });
      
      // Wait for page to load
      await page.waitForSelector('div', { timeout: 5000 });
      
      await page.screenshot({
        path: path.join(ASSETS_DIR, 'peek-token-flow.png'),
        fullPage: false
      });
      console.log('   ✓ Captured peek-token-flow.png');
    } catch (error) {
      console.log('   ⚠ Failed to capture Peek token flow:', error.message);
    }
    
    console.log('\n✓ Screenshot capture complete!');
    console.log(`\nOutput files:`);
    console.log(`  - ${path.join(ASSETS_DIR, 'mcp-generate-image.png')}`);
    console.log(`  - ${path.join(ASSETS_DIR, 'mcp-understand-image.png')}`);
    console.log(`  - ${path.join(ASSETS_DIR, 'peek-token-flow.png')}`);
    
  } catch (error) {
    console.error('\n✗ Error during screenshot capture:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// Run with error handling
captureScreenshots().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
