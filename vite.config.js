import { defineConfig } from 'vite';

export default defineConfig({
    base: process.env.NODE_ENV === 'production' ? '/nibi/' : '/',
    build: {
        rollupOptions: {
            output: {
                entryFileNames: 'assets/main.js',
                assetFileNames: (assetInfo) => {
                    if (assetInfo.name?.endsWith('.css')) return 'assets/style.css';
                    if (assetInfo.name?.endsWith('.woff2')) return 'assets/[name][extname]';
                    return 'assets/[name][extname]';
                },
            },
        },
    },
});
