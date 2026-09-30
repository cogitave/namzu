import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({ plugins: [tailwindcss()], base: './', build: { outDir: 'dist/renderer', emptyOutDir: true }, server: { host: '127.0.0.1' } })
