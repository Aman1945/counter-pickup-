import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :3000; in the Docker image the API serves the built files itself.
const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/products': api, '/orders': api, '/payments': api },
  },
});
