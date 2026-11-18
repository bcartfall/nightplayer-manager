import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// `npm run dev` proxies /api to the running Nightplayer Manager (default http://localhost:3001).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [vue(), tailwindcss()],
    server: { proxy: { '/api': { target: env.VITE_PROXY || 'http://localhost:3001', changeOrigin: true } } },
    build: { chunkSizeWarningLimit: 700 },
  };
});
