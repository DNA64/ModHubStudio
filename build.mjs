// Bundles src/ into one self-contained page: dist/index.html.
// React, ReactDOM, JSZip and SparkMD5 load from cdnjs at runtime.
import * as esbuild from 'esbuild';
import fs from 'fs';
const out = await esbuild.build({ entryPoints: ['src/main.jsx'], bundle: true, format: 'iife', write: false, minify: true,
  jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', target: 'es2020' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('src/styles.css', 'utf8');
const head = `<title>Mod Hub Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${css}</style>`;
const body = `<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/spark-md5/3.0.2/spark-md5.min.js"></script>
<script>${js}</script>`;
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n${head}\n</head><body>\n${body}\n</body></html>\n`);
console.log('built dist/index.html', (fs.statSync('dist/index.html').size / 1024).toFixed(1) + ' KB');
