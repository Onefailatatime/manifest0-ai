# Accuracy

Source: live test visits on the deployed app, Oct 30 to Nov 4, 2026, using our 3 sample products (photos in `samples/`). We checked what Muse Spark read against each product's published Safety Data Sheet and label. Fields we could not check are marked unverified.

| Product | Product name | Manufacturer | Signal word | Hazard statements | SDS found | Right SDS? |
| --- | --- | --- | --- | --- | --- | --- |
| Clorox Disinfecting Bleach | Correct | Correct | DANGER, correct | Correct ("Corrosive. Causes irreversible eye damage and skin burns...") | Yes, Clorox's own US SDS | Yes, likely (Clorox Disinfecting Bleach SDS; exact label variant unverified) |
| Great Value Cleaning Vinegar | Correct | Correct (brand as printed) | none read, unverified | none read, unverified | Yes, the maker's (KIK International) Vinegar Cleaner SDS | Unverified: same maker, store-brand match, Muse rated it medium confidence |
| STERIS Septihol RTU Alcohol Solution | Correct | Correct | DANGER, correct | 3 of 3 correct (H225, H319, H336) | Yes, STERIS-authored US SDS (distributor-hosted) | Yes |

**Summary:** 10 of 10 checkable label fields correct across the 3 products. An SDS was found for all 3, and confirmed as the right one for 2.

**All live test visits (Oct 30 to Nov 4):** 25 products from 25 photos. An SDS PDF was found for 18. For 5, only a web page was found. For 3, none was found (unlabeled mixed items such as "assorted aerosols").

Notes:
- "Correct" means it matches the product's published label and SDS.
- EPA container codes come from the app's own rules, not Muse, and are not part of this check.
