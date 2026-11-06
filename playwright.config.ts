import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 13'] }, testMatch: /touch.*\.spec\.ts|intro-flow\.spec\.ts/ },
  ],
})
