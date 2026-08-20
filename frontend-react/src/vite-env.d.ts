/// <reference types="vite/client" />

// [NEW v13] Without this, `import logoUrl from "./assets/logo.png"` is a
// tsc error — the build gate is `tsc --noEmit && vite build`, and tsc has no
// idea that Vite turns an image import into a URL string. The triple-slash
// reference above is what declares those modules; this file exists solely to
// carry it, which is the conventional Vite layout.
