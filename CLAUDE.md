# bff-photo-booth — project notes

Mobile-first self-shoot photo booth: a guest builds a 4-photo layout on their phone,
it prints from the MacBook running the server.

## Layout rules (the picker grid) — DO NOT VIOLATE

These are hard requirements for the "choose your layout" grid (`resolveGrid` /
`designVariants` in `public/js/layouts.mjs`). They have been re-litigated many times —
follow all of them:

1. **Maximize used space.** Compute it properly — this is an optimization problem, not a
   fixed template. Search the real layout space (sheet orientation, arrangements, sizes)
   and pick the arrangement with the greatest total photo area (coverage). Use the best
   algorithm the situation allows; do not hard-code one template and hope.
2. **Never crop the photos.** Every photo is shown whole — each cell has the SAME aspect
   ratio as its photo (no cover-fit cropping, no letterbox bars). The leftover space is
   the decorative watercolor paper showing through (matting).
3. **Exactly one hero image.** One photo is featured, visibly larger than the rest.
4. **Cap the hero.** The hero is larger than the others but **never more than 2× the area
   of the smallest photo**. ("100% bigger" and no more.)
5. **Five elements in the grid:** the 4 user-selected photos **and the sticker**. The
   sticker is a real cell in the layout (not an overlay), and it can **never** be the
   hero (never the largest cell).

### The unavoidable trade-off (know this before "fixing" the gaps)

Rules 1, 2 and 4 genuinely conflict. Whole photos of real camera shapes cannot tile a
rectangle, so "no crop" + "filled page" cannot both be 100%. And holding the hero to a
gentle 2× (rule 4) forces every photo to be within 2× of the others — near-equal, large
photos can't tile the sheet, so some watercolor paper always shows. The optimizer already
returns the mathematical maximum coverage under rules 2/4; the remaining paper is the cost
of the cap, not a bug. If a filled page matters more than the cap, the only two levers are
(a) allow the hero past 2×, or (b) allow cropping — both are currently disallowed, so do
not silently reintroduce either. If the paper still reads as "too much", raise it with the
user as a rules trade-off; don't break a rule to hide it.

### Practical notes
- The guest's photos are often **landscape group shots** — the optimizer must pick the
  sheet orientation (4×6 portrait vs 6×4 landscape) by coverage, not assume portrait.
- The sticker asset is `public/backgrounds/sticker.png` (aspect ≈ 1.33). Its cell is
  shaped to that aspect so the badge fills it with no paper inside the sticker cell.

## Shipping a change
Every change ships as a version bump: update `package.json` version, add a `CHANGELOG.md`
entry for that version, run `node --test test/*.test.mjs`, run `node scripts/build-site.mjs`,
commit, and push to the working branch. Always mention the version number at the very
bottom of chat replies.
