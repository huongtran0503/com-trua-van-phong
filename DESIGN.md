# Cơm Trưa UI

## Direction

Simple, modern Vietnamese office lunch ordering. Native HTML, CSS and JavaScript,
using the existing Express application. Design variance 5, motion intensity 3,
visual density 3. Motion is limited to interaction feedback and honors reduced motion.

The previous UI used a narrow 860px shell, repeated elevated panels, emoji dish
illustrations and multiple competing semantic colors. The refresh uses a 1280px
shell, a single lunch photograph, quiet surfaces and a separate order options panel.
Existing branding, navigation labels, date controls, routes, SEO title/description,
form fields and API endpoints are retained.

## Daily menu

The menu remains an array of dish names, entered one per line for each date.
There are no dish photo mappings, category records or additional management screens.
The hero photograph is decorative and stays the same when the daily menu changes.

## Dish ratings

The "Đánh giá" tab lists every dish that has ever been on a menu, matched across days by
normalized name since the menu is retyped daily. Anyone can vote without ordering: one vote
per person per dish (1-5 stars, tap the same star to withdraw), and voting again replaces the
old vote. The "Đơn của bạn" card offers the same stars for the dishes just ordered.

A dish is "được đề cử" once at least two people rated it and its score, pulled toward the
overall mean with a weight of two votes, is 4 or higher. Recommended dishes get an amber star
on the order chips, a one-line "Đề cử hôm nay" under the menu heading, a tag in the Đánh giá
list and a place in its "Món được đề cử" card (top 10, top 5 on phones). Ratings use
`/api/ratings` and `/api/rating`, separate from the 3.5s state poll.

## Tokens

- Typography: self-hosted Plus Jakarta Sans, including Vietnamese and Latin subsets.
- Icons: official Phosphor regular glyphs, subset to the icons used by this app.
- Light: canvas `#fafafa`, surface `#fefefe`, text `#222426`.
- Dark: canvas `#17191b`, surface `#1e2023`, text `#f0f1f2`.
- Brand and accent: cucumber green `#2f6b3b` (buttons, selection, icon tile; white text 6.1:1), lightened to cucumber flesh `#9ccb86` in dark mode. Selected surfaces use `#eaf3e5`.
- Stars: amber `#b87308` (dark `#e8b04a`) for star glyphs only, never text; unset stars `#d4d7da` (dark `#4a4f55`).
- Shapes: 20px hero, 16px panels, 12px dish choices, 10px inputs, pill buttons.
- Layers: form content 1, toast 10, dialog 20, skip link 30.
- Below 768px: explicit single-column form in its original field order.
- Theme defaults to the system preference, with a saved manual override.

## Assets and verification

The lunch photo was generated specifically for this UI and exported as two WebP
sizes. Fonts and icons are served locally; their licenses are beside the assets.

`npm run test:ui` checks the UI with an isolated, in-memory API fixture and Chrome.
It covers ordering, editing, cancellation, ordering for others, locking, daily menu
editing, error/retry, offline cache, keyboard tabs, dialogs, themes and 320-1440px widths.
It never writes to the application database.

`npm run audit:ui` runs Lighthouse against an isolated fixture server. Reports and
screenshots are saved to ignored `artifacts/`. The audit requests exclusion of the
local Kaspersky integration's URLs. Host-injected scripts can still affect scores.
