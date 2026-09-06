const fs = require('fs');
const path = require('path');

const base = 'node_modules/geist/dist/fonts';
const faces = [
  { file: `${base}/geist-sans/Geist-Variable.woff2`, family: 'Geist', style: 'normal' },
  { file: `${base}/geist-sans/Geist-Italic[wght].woff2`, family: 'Geist', style: 'italic' },
  { file: `${base}/geist-mono/GeistMono-Variable.woff2`, family: 'Geist Mono', style: 'normal' },
];

let out = `/**
 * Geist, bundled as data URIs.
 *
 * The renderer is loaded with loadFile(), so its origin is file:// - and the
 * app's CSP is font-src 'self' data:. A font emitted as a separate asset is
 * not reliably 'self' under file://, so the bytes are embedded here instead.
 * That also keeps the app genuinely offline: no font request, ever.
 *
 * Generated from the "geist" devDependency - do not hand-edit. To regenerate
 * after a font bump: node scripts/gen-fonts.js
 */
`;

for (const face of faces) {
  const b64 = fs.readFileSync(face.file).toString('base64');
  out += `
@font-face {
  font-family: '${face.family}';
  font-style: ${face.style};
  font-weight: 100 900;
  font-display: swap;
  src: url(data:font/woff2;base64,${b64}) format('woff2-variations');
}
`;
}

fs.writeFileSync('src/fonts.css', out);
console.log('wrote src/fonts.css', (fs.statSync('src/fonts.css').size / 1024).toFixed(0) + ' KB');
