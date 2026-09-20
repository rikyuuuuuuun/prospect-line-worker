import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      TRIAL_CONFIG_BRIDGE_ONLY: 'false',
      GAS_WEBHOOK_URL: 'https://gas.invalid/exec', GAS_FORWARD_KEY: 'test-only-key',
      LINE_LOGIN_CHANNEL_ID: 'test-channel',
      LINE_SECRET_B_TSURUSE: 'test-channel-secret',
    } },
  })],
  test: { include: ['test-worker/*.spec.js'], fileParallelism: false },
});
