#!/usr/bin/env bash
# Exports every brand file the apps serve from the SVG sources in this folder and the HTML scenes
# in visuals/. Needs rsvg-convert and ImageMagick (icons), cwebp, sips (macOS, for JPEG) and
# Google Chrome (scenes). Run from anywhere: assets/brand/export.sh [icons|scenes|all]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
what="${1:-all}"
out="$here/export"
mkdir -p "$out"

png() { # svg size dest
  rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
}

icons() {
  local tmp
  tmp="$(mktemp -d)"
  # Favicons: the adaptive SVG, and an ICO with the dark tile at 16, 32 and 48.
  for s in 16 32 48; do png "$here/favicon-tile.svg" "$s" "$tmp/fav-$s.png"; done
  magick "$tmp/fav-16.png" "$tmp/fav-32.png" "$tmp/fav-48.png" "$out/favicon.ico"
  chmod 644 "$out/favicon.ico"
  # PWA icons ("any" is the rounded tile, "maskable" keeps the glyph inside the 80% safe circle)
  # and the iOS touch icon (full bleed and opaque, iOS rounds the corners itself).
  png "$here/app-icon.svg" 192 "$out/icon-192.png"
  png "$here/app-icon.svg" 512 "$out/icon-512.png"
  png "$here/app-icon-maskable.svg" 192 "$out/icon-maskable-192.png"
  png "$here/app-icon-maskable.svg" 512 "$out/icon-maskable-512.png"
  png "$here/app-icon-ios.svg" 180 "$out/apple-touch-icon.png"
  rm -rf "$tmp"
  # The README art (tools/make_readme_art.py) draws the glyph and the lockup from these.
  for v in on-light on-dark; do
    rsvg-convert -w 512 "$here/glyph-$v.svg" -o "$out/glyph-$v.png"
    rsvg-convert -w 1600 "$here/lockup-$v.svg" -o "$out/lockup-$v.png"
  done

  # The app (frontend/public and app/).
  mkdir -p "$root/frontend/public/icons"
  cp "$here/favicon.svg" "$root/frontend/public/tredio-favicon.svg"
  cp "$out/favicon.ico" "$root/frontend/public/favicon.ico"
  for f in icon-192 icon-512 icon-maskable-192 icon-maskable-512 apple-touch-icon; do
    cp "$out/$f.png" "$root/frontend/public/icons/$f.png"
  done
  # The share cards draw this file in a 154 x 27 box, so its canvas is padded on the right to
  # that shape and the lockup sits flush left.
  sed -E 's/viewBox="0 0 ([0-9.]+) ([0-9.]+)" width="[0-9.]+" height="[0-9.]+"/viewBox="0 0 PADW \2" width="PADW" height="\2"/' \
    "$here/lockup-on-dark.svg" > "$out/lockup-share.svg"
  h="$(sed -nE 's/.*viewBox="0 0 [0-9.]+ ([0-9.]+)".*/\1/p' "$here/lockup-on-dark.svg")"
  w="$(awk -v h="$h" 'BEGIN { printf "%.2f", h * 154 / 27 }')"
  sed "s/PADW/$w/g" "$out/lockup-share.svg" > "$root/frontend/public/tredio-icon-logo.svg"
  rm "$out/lockup-share.svg"

  # The admin panel.
  cp "$here/favicon.svg" "$root/admin/public/tredio-favicon.svg"
  cp "$out/favicon.ico" "$root/admin/public/favicon.ico"

  # The website (file-based icons in src/app, logos in public/assets/svg).
  cp "$here/favicon.svg" "$root/landing-page/src/app/icon.svg"
  cp "$out/favicon.ico" "$root/landing-page/src/app/favicon.ico"
  cp "$out/apple-touch-icon.png" "$root/landing-page/src/app/apple-icon.png"
  mkdir -p "$root/landing-page/public/assets/svg"
  cp "$here/lockup-white.svg" "$root/landing-page/public/assets/svg/tredio-icon-logo.svg"
  cp "$here/wordmark-on-dark.svg" "$root/landing-page/public/assets/svg/tredio-wordmark.svg"
}

# Renders one scene of visuals/studio.html to a PNG of its own size.
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
scene() { # name width height dest.png
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$2,$3" --virtual-time-budget=4000 --default-background-color=00000000 \
    --screenshot="$4" "file://$here/visuals/studio.html#$1" >/dev/null 2>&1
}
webp() { cwebp -quiet -q "${3:-86}" "$1" -o "$2"; }
jpeg() { sips -s format jpeg -s formatOptions "${3:-88}" "$1" --out "$2" >/dev/null; }

scenes() {
  local tmp img="$root/landing-page/public/assets/img"
  tmp="$(mktemp -d)"
  # Link cards and the X banner.
  scene og-site 1200 630 "$out/og-site.png"
  scene og-app 1200 630 "$out/og-app.png"
  scene x-banner 1500 500 "$out/x-banner.png"
  jpeg "$out/og-site.png" "$root/landing-page/src/app/opengraph-image.jpg"
  cp "$root/landing-page/src/app/opengraph-image.jpg" "$root/landing-page/src/app/twitter-image.jpg"
  cp "$out/og-app.png" "$root/frontend/app/opengraph-image.png"
  cp "$out/og-app.png" "$root/frontend/app/twitter-image.png"
  # The hero poster, shown until the product film is in place.
  mkdir -p "$root/landing-page/public/assets/video"
  scene hero-poster 1920 1080 "$tmp/hero-poster.png"
  webp "$tmp/hero-poster.png" "$root/landing-page/public/assets/video/hero-poster.webp" 88
  # Website pictures.
  for s in about-review:2400:1350 about-markets:2400:1350 about-account:2400:1350 \
    example-near:1600:1000 example-agents:1600:1000 example-heatwave:1600:1000 \
    track-memecoins:1200:1200 track-social:1200:1200 track-defi:1200:1200 track-agents:1200:1200 \
    stats-rounds:1600:1066 stats-deposits:1600:1066; do
    IFS=: read -r name w h <<< "$s"
    scene "$name" "$w" "$h" "$tmp/$name.png"
    webp "$tmp/$name.png" "$img/$name.webp"
  done
  rm -rf "$tmp"
}

case "$what" in
  icons) icons ;;
  scenes) scenes ;;
  all) icons; scenes ;;
  *) echo "usage: $0 [icons|scenes|all]" >&2; exit 2 ;;
esac
echo "exported $what"
