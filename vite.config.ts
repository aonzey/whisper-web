import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The bundled API server (npm run server). Vite proxies /api to it during
// development so the frontend can simply use "/api" as its base url.
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:8787";

// `/models` serves the cached 🤗 weights (see server/index.js). Without the
// proxy the dev server answers with its own index.html and the browser engine
// fails with "Unexpected token '<' ... is not valid JSON".
const proxyRules = {
    "/api": {
        target: apiTarget,
        changeOrigin: true,
    },
    "/models": {
        target: apiTarget,
        changeOrigin: true,
    },
};

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: proxyRules,
    },
    // `vite preview` needs its own proxy block, otherwise the built app cannot
    // reach the API server and the model list silently falls back to aliases.
    preview: {
        proxy: proxyRules,
    },
});
