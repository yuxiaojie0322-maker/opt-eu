// @ts-check
const { defineConfig, devices } = require('@playwright/test');

let proxyServer = process.env.PROXY_URL || '';
if (!proxyServer) {
  if ((process.env.VLESS_NODE || '').trim()) {
    proxyServer = 'socks5://127.0.0.1:10808';
  } else if ((process.env.NODE_LINK || '').trim()) {
    proxyServer = 'socks5://127.0.0.1:1080';
  }
}

module.exports = defineConfig({
  testDir: './tests',
  timeout: 180_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--window-size=1280,900',
      ],
    },
    ...(proxyServer
      ? {
          proxy: {
            server: proxyServer,
          },
        }
      : {}),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
