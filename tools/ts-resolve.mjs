// Pemuat tes Node: impor relatif tanpa ekstensi ('./deriz-synth') diarahkan ke file .ts, seperti bundler Vite.
// Pakai: node --import ./tools/ts-resolve.mjs --experimental-transform-types tools/deriz-bake-test.ts
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[cm]?[jt]s$/.test(spec) && ctx.parentURL) {
    const u = new URL(spec + '.ts', ctx.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
  }
  return next(spec, ctx);
}`), import.meta.url);
