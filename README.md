# Crow Animation – deploy-ready optimized package

Pacchetto statico pronto per deploy. Non richiede build obbligatoria: carica `index.html` su GitHub Pages, Netlify, Vercel static, Cloudflare Pages o qualsiasi hosting statico.

## Cosa è stato modificato

- Rimosso il vincolo runtime da Lenis/CDN: il progetto ora gira con JavaScript vanilla.
- Asset loading configurabile tramite `data-asset-base` sullo script.
- Qualità adattiva `high / medium / low` in base a device memory, CPU, connessione, `saveData`, mobile e `prefers-reduced-motion`.
- DPR massimo ridotto e adattivo per contenere memoria GPU e costi di repaint.
- Preload critico più selettivo, caricamento progressivo in idle e look-ahead controllato.
- `Image.decode()` e `crossOrigin="anonymous"` per migliorare stabilità decode e compatibilità canvas con asset remoti.
- Fallback video lazy: il video non viene caricato subito, ma solo se la sequenza canvas fallisce.
- Fallback visivo al frame più vicino già caricato, per evitare buchi durante scroll aggressivi.
- CSS variables aggiornate solo quando cambiano, riducendo lavoro inutile sul main thread.
- Effetti costosi ridotti su device medi/deboli: grain più lento, overlay disattivabili, progressive enhancement.
- Modalità debug con `?debug=1` per vedere quality tier, renderer, frame caricati e heap.
- Aggiunti file minimi per governance deploy: `package.json`, `lighthouse.config.cjs`, `.nojekyll`.

## Deploy rapido

```bash
npm run serve
```

Poi apri:

```txt
http://127.0.0.1:8080
```

Per debug runtime:

```txt
http://127.0.0.1:8080?debug=1
```

## Asset

Di default il pacchetto carica frame e video dal repository originale:

```html
<script
  src="script.js"
  data-asset-base="https://raw.githubusercontent.com/joemaserati-lab/crow-animation/main/"
  defer
></script>
```

Per renderlo 100% self-hosted:

1. Copia dentro questa cartella le directory originali `frames/`, `frames-mobile-portrait/` e il file `crow-threshold-scrub.mp4`.
2. Modifica `index.html` così:

```html
<script src="script.js" data-asset-base="" defer></script>
```

## Test performance

```bash
npm install
npm run lighthouse
```

I report vengono salvati in `./reports/`.

Target iniziali consigliati:

- Performance score Lighthouse: >= 0.80
- Total Blocking Time: <= 200 ms
- Largest Contentful Paint: <= 2.5 s
- Nessuna long task ripetuta durante scroll aggressivo
- Nessuna crescita heap persistente dopo sessione lunga

## Note operative

Questo pacchetto applica i quick wins ad alto ROI. Non include ancora OffscreenCanvas/Worker o texture pooling: sono interventi di fase 2, da implementare solo dopo aver misurato il baseline con trace reali su desktop e mobile target.
