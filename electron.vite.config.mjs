import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  main: {},
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    plugins: [vue()],
    build: {
      assetsInlineLimit: 0,
      minify: process.env.ZESTLOOMER_UNMINIFIED === '1' ? false : 'esbuild'
    }
  }
})
