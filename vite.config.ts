import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const REQUIRED_BUILD_ENV = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

export default defineConfig(({ command, mode }) => {
  // Build sırasında zorunlu değişkenler eksikse dur; aksi halde hata sadece tarayıcıda görünür.
  if (command === 'build') {
    const env = loadEnv(mode, process.cwd(), 'VITE_');
    const missing = REQUIRED_BUILD_ENV.filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(`Build durdu: ${missing.join(', ')} tanımlı değil (.env.example'a bakın)`);
    }
  }

  return {
    plugins: [react()],
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      env: {
        VITE_SUPABASE_URL: 'https://test.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'test-anon-key',
        VITE_API_BASE_URL: 'http://localhost:3000',
        VITE_AUTH_SESSION_MODE: 'mock',
      },
    },
  };
});
