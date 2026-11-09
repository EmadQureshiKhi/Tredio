# Share card fonts

ImageResponse (satori) reads TTF, OTF and WOFF but not WOFF2, so the link cards load these static TTF instances from Google Fonts.
The file names are the ones `src/features/share/og.tsx` reads; the faces inside are open fonts under the SIL Open Font License 1.1.

| File | Font | Licence |
| --- | --- | --- |
| `hanken-grotesk-light.ttf` | Hanken Grotesk Light (300) | `OFL-HankenGrotesk.txt` |
| `hanken-grotesk-medium.ttf` | Hanken Grotesk Medium (500) | `OFL-HankenGrotesk.txt` |
| `newsreader-light.ttf` | Newsreader 72pt Light (300) | `OFL-Newsreader.txt` |

The app loads the same families through `next/font/google` in `app/fonts.ts`.
