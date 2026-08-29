# bff-photo-booth — project notes

Mobile-first self-shoot photo booth: a guest builds a 4-photo layout on their phone,
it prints from the MacBook running the server.

## Layout rules (the picker grid) — the user's rules, verbatim

These are the user's exact rules for the "choose your layout" grid (`resolveGrid` /
`designVariants` in `public/js/layouts.mjs`). Follow them as written — do NOT add extra
constraints, and do NOT rewrite them into your own words or bake in excuses:

1. Compute for the best possible space maximization. Use proper math to do it. Use the
   best optimization algorithm possible.
2. No cropping.
3. There should be one hero image.
4. The hero image should be larger than the rest but never more than 2× the smallest photo.
5. There are 5 elements to fit in the grid: the 4 user-selected photos and the sticker.
   The sticker should never be the hero image.

Notes (implementation, not extra rules): the sticker asset is
`public/backgrounds/sticker.png` (aspect ≈ 1.33). Photos are often landscape group shots,
so the optimizer chooses the sheet orientation (4×6 portrait vs 6×4 landscape) by which
maximizes space — it does not assume portrait.

## Shipping a change
Every change ships as a version bump: update `package.json` version, add a `CHANGELOG.md`
entry for that version, run `node --test test/*.test.mjs`, run `node scripts/build-site.mjs`,
commit, and push to the working branch. Always mention the version number at the very
bottom of chat replies.
