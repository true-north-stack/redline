import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  reporter: 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
