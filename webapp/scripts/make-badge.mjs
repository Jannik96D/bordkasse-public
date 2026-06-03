// Erzeugt public/badge-96.png — das monochrome Status-Leisten-Symbol für
// Web-Push-Benachrichtigungen (Android tönt es ein; eine weiße Anker-
// Silhouette auf Transparenz ist daher korrekt). Reproduzierbar via:
//   pnpm exec node scripts/make-badge.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";

// Bewusst bold (stroke-width 8 @ 96px), damit der Anker beim Herunterskalieren
// auf ~24px in der Statusleiste nicht zu einer dünnen Linie zerfällt.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <g fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="48" cy="19" r="8"/>
    <path d="M48 27 V83"/>
    <path d="M34 42 H62"/>
    <path d="M19 53 a29 29 0 0 0 58 0"/>
  </g>
</svg>`;

const out = fileURLToPath(new URL("../public/badge-96.png", import.meta.url));
await sharp(Buffer.from(svg)).png().toFile(out);
console.log("badge-96.png geschrieben:", out);
