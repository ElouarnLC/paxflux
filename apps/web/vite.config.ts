import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'PaxFlux',
        short_name: 'PaxFlux',
        description: 'Self-hosted realtime crowd flow & occupancy management.',
        // The launch contract, stated rather than inherited.
        //
        // `start_url` and `scope` were already '/' — VitePWA injects both as
        // defaults — but a default is not a contract: it can move under a
        // plugin upgrade, and nothing in the repository said what PaxFlux
        // intends. `id` was genuinely absent, which leaves the browser to
        // derive application identity from the start URL; declaring it fixes
        // the identity even if a future start URL ever changes.
        //
        // '/' and not '/counter': one application serves staff browsers and
        // paired handsets alike, and which one this browser is belongs to
        // the smart root router in `app/root-route.ts`, which reads local
        // pairing state. A start URL cannot know that, and encoding a
        // pairing token, session, event or checkpoint in it would put a
        // secret in a file every installed copy carries.
        id: '/',
        start_url: '/',
        scope: '/',
        // The sRGB rendering of the `--background` token in
        // src/styles/index.css (oklch(0.165 0.020 258)). A manifest cannot
        // read a CSS custom property, so these two literals are kept in
        // step with the token by hand.
        theme_color: '#090f17',
        background_color: '#090f17',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/health\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^\/health\//,
            handler: 'NetworkOnly',
          }
        ]
      }
    })
  ],
  resolve: {
    // Mirrors the `@/*` path mapping in tsconfig.json. Both are needed:
    // TypeScript resolves the import for typechecking, Vite resolves it at
    // build time, and they have to agree.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  }
});
