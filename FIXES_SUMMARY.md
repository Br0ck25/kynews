# Fixes Summary

This document summarizes the changes made to address the seven edge cases in
`geo.ts`/`ky-geo.ts` for the Kentucky news article geo-detection system.

## Issues Addressed

1. **Ambiguous county names**
   - Added `AMBIGUOUS_COUNTY_NAMES` set and tightened matching logic in both
     `detectAllCounties` and `detectCounty`.
   - Enumeration pass now filters ambiguous counties individually.
   - Updated regex patterns to include plural forms and escape sequences.
   - Added tests validating behavior with and without Kentucky context and
     out-of-state signals.

2. **Common-word city names (noise)**
   - Added `NOISE_CITY_NAMES` set and excluded them from auto-detection.
   - Filter applied during `SORTED_CITY_ENTRIES` construction.
   - Added tests ensuring noise names are not matched.

3. **Enumeration regex word-boundary gaps**
   - Reworked Pass B regex to wrap each county alternative with `\b`.
   - Ensures substrings like "Lee" do not match inside "Leesburg".

4. **Multi-county cities and merged results**
   - Created `KY_CITY_TO_COUNTIES` parallel map with arrays of counties.
   - Adjusted `detectKentuckyGeo` to run city detection even when explicit
     county names are present and merge the two result sets. County names
     found directly retain priority in the returned array.
   - Added `corbin` to base `KY_CITY_TO_COUNTY` map and multi-county entries
     for identified cities.
   - Added tests for both pure city-based lookups and combined county/city
     scenarios to guard against regressions.

5. **Federal district phrases**
   - Added `SUPPRESSED_PHRASES` constant (for documentation) and logic in
     `detectCity` to skip matches followed by “district”.
   - Added tests to prevent "Eastern District of Kentucky" from matching
     the city of Eastern.

6. **Plural "counties" form**
   - Updated both Pass A and Pass B regex constructions to recognize
     "counties" as a valid suffix.
   - Added tests covering plural forms in various constructions.

7. **Hyphenated/slash-separated county lists**
   - Enhanced Pass B regex to accept `/` and `-` as separators.
   - Added adjacency handling so that normalized text (punctuation→spaces)
     still yields all counties.
   - Updated tests to cover slash, hyphen, and combined cases.

Additional general changes:
- Added extensive comments and JSDoc annotations for new constants.
- Maintained backward compatibility of `detectCounty` output.
- Added comprehensive unit tests and debug scripts during development.

## Remaining Issues

- No unresolved issues related to the geo-detection fixes.
- Some unrelated frontend tests still fail due to environment limitations
  (localStorage, missing describe hooks); these were present prior and not
  affected by the geo changes.

## Breaking Changes

None. All exported function signatures are unchanged and behaviour for
non-ambiguous counties/cities remains the same or stricter (no regressions).
The `KY_CITY_TO_COUNTIES` export is new but does not impact existing callers.

## Migration Notes

- When referencing city-to-county mappings, callers may now access
  `KY_CITY_TO_COUNTIES` if they need arrays instead of a single value.
- Be aware that ambiguous counties will no longer match without explicit
  Kentucky context.

## Verification Steps

1. Run `npm run test` (React/test suite) to ensure frontend remains unaffected.
2. Run `npx vitest run` and confirm all geo-related tests pass (15 tests).
3. Manually validate `detectKentuckyGeo` on representative article snippets:
   - "Police in Corbin..." → counties Whitley/Knox/Laurel
   - "Eastern District of Kentucky" → no city match
   - "Todd County near Ohio River in Kentucky" → no match
   - "Knox-Laurel-Clay County in Kentucky" → all three counties

These results were validated during development using debugging scripts.

---

All edge cases have now been addressed with the applied modifications.
