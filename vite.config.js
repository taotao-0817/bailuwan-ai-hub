import { defineConfig } from 'vite';
export default defineConfig({
  root: 'frontend',
  server: { port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8788' } },
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 950,
    rollupOptions: { output: { manualChunks: { three: ['three'], vendor: ['react', 'react-dom'] } } } }
});
