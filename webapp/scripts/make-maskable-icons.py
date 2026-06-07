# Erzeugt public/icon-192-maskable.png + public/icon-512-maskable.png — die
# Android-"adaptive"/maskable Varianten des App-Icons.
#
# Hintergrund: Android schneidet maskable-Icons in eine adaptive Form (Kreis/
# Squircle) und verwirft alles ausserhalb der inneren ~80 % ("Safe Zone",
# Kreis mit Radius 40 % = 205 px bei 512). Das volle Logo (icon-512.png) reicht
# mit den Segelspitzen ueber diese Zone hinaus → die Ecken wurden abgeschnitten.
# Diese Maskable-Varianten skalieren dasselbe Logo so weit herunter, dass seine
# Bounding-Box komplett innerhalb der Safe Zone liegt, auf gefuelltem Marken-
# Hintergrund (#FAFBFC). Das volle icon-{192,512}.png bleibt fuer purpose:"any".
#
# Reproduzierbar via:  python3 scripts/make-maskable-icons.py
import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "icon-512.png"
BG = (250, 251, 252, 255)  # #FAFBFC — gleicher Hintergrund wie manifest background_color
# Maximaler Abstand einer Logo-Bounding-Box-Ecke vom Zentrum (px @512). Die
# Safe-Zone hat Radius 205; 190 laesst bewusst ~3 % Luft fuer engere OEM-Masken.
TARGET_CORNER = 190


def bbox_nonbg(im: Image.Image) -> tuple[int, int, int, int]:
    """Bounding-Box aller Nicht-Hintergrund-Pixel (Logo-Ausdehnung)."""
    w, h = im.size
    px = im.load()

    def is_bg(r: int, g: int, b: int, a: int) -> bool:
        return a < 10 or (r > 235 and g > 238 and b > 240)

    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if not is_bg(r, g, b, a):
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
    return (min_x, min_y, max_x + 1, max_y + 1)


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    # Transparenz zuerst auf den Marken-Hintergrund legen, dann Logo freistellen.
    flat = Image.new("RGBA", src.size, BG)
    flat.alpha_composite(src)
    logo = flat.crop(bbox_nonbg(flat))
    lw, lh = logo.size
    half_diag = math.hypot(lw / 2, lh / 2)

    for size in (192, 512):
        target_corner = TARGET_CORNER * (size / 512.0)
        scale = target_corner / half_diag
        w, h = max(1, round(lw * scale)), max(1, round(lh * scale))
        art = logo.resize((w, h), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), BG)
        canvas.alpha_composite(art, ((size - w) // 2, (size - h) // 2))
        out = ROOT / "public" / f"icon-{size}-maskable.png"
        # Opak speichern (kein Alpha): maskable-Icons muessen die Flaeche fuellen.
        canvas.convert("RGB").save(out)
        print(f"geschrieben: {out}")


if __name__ == "__main__":
    main()
