import { defineConfig } from 'vite';
import wgsl from 'vite-plugin-wgsl';

export default defineConfig({
  server: { port: parseInt(process.env.PORT ?? '5173') },
  // palette.wgsl is prepended to other shaders, so its function names must
  // survive minification (locals and parameters are still mangled).
  plugins: [wgsl({ include: ['**/*.wgsl'], renameFunctions: false })],
});
