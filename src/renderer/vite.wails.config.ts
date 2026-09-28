import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Wails 2.16 copies frontend:dir/dist into the Go embed target during build,
// then restores that target's .gitkeep. Keep this output in frontend:dir.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
