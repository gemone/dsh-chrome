import { defineConfig } from 'tsdown'

// Standalone build for an out-of-tree DSH bundle plugin. Transpiles src/ → lib/
// without project references or type checking (mirrors the turtle-ui git-install
// `prepare` pattern described in the DSH publish cookbook), so a `dsh plugin add
// github:.../dsh-chrome` builds the published entry points from source on
// install without assuming a sibling monorepo checkout.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'lib',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  clean: true,
  dts: true,
  // Emit `.js` / `.d.ts` (respect package.json "type": "module") rather than the
  // explicit `.mjs` / `.d.mts` extensions, matching the DSH package convention.
  fixedExtension: false,
  unbundle: false,
})
