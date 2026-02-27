# Tagging System Documentation

This document outlines the rules and reasoning behind the article tagging
system used by the Kentucky News project.  Tags are assigned during
ingestion/classification and inform both feeds and editorial workflows.

## Primary Tags

Every article must be tagged with **Kentucky**, **National**, or both.
Start by determining if an article has a Kentucky angle.  If it does,
tag it **Kentucky** first.  Then determine whether the story also has
national significance — meaning it would be relevant to audiences outside
of Kentucky.  If yes, add the **National** tag as well.

## National Articles

If an article is tagged **National**, determine whether it also requires a
**Weather** tag.  National weather stories should appear in the weather
feed alongside weather coverage of Kentucky.

## Kentucky Articles

When an article is tagged **Kentucky**, attempt to identify the
appropriate county tag using the following logic:

1.  Try to identify the county directly from the article text ("Pike
    County", "Jefferson Co.", etc.).
2.  If no county is found, look for a city name.  Cross‑reference any
    city you find against `Kentucky_Counties_and_Cities.md` to determine
    the correct county.
3.  If a city appears in multiple counties in
    `Kentucky_Counties_and_Cities.md`, use the context of the article to
    choose the proper county.  When context is insufficient, apply *all*
    matching county tags.
4.  If multiple Kentucky counties or cities are mentioned in the same
    article, apply all appropriate county tags.
5.  Do **not** infer a county from outside knowledge; the markdown file is
    the source of truth.  If a city is missing from the file, update the
    file rather than guessing.
6.  If neither a county nor a recognizable city can be identified, the
    article simply receives the **Kentucky** tag.  Statewide stories do
    not always need a county.

## Additional Tags

Apply any of the following tags when they are relevant to the primary
or secondary focus of the article:

* **Weather** — primary or substantial focus on weather events, forecasts,
  warnings, or weather-related impacts.
* **Sports** — coverage of athletic events, teams, scores, or sports news
  at any level (professional, collegiate, or K–12).
* **School** — stories about K–12 or higher education, school policy,
  closures, safety, or academic issues.

> Example: A weather event in Lexington could be tagged: `Kentucky, Fayette,
> Weather`.
>
> Example: A federal education policy story impacting Kentucky schools
> could be tagged: `Kentucky, National, School`.

## Feeds

Feed logic relies on the combination of tags:

| Feed                  | Articles included                                      |
|-----------------------|--------------------------------------------------------|
| **Today**             | Articles tagged **Kentucky**                           |
| **Weather**           | Articles tagged **Kentucky + Weather** *or*
|                       | **National + Weather**                                 |
| **Sports**            | Articles tagged **Kentucky + Sports**                  |
| **Schools**           | Articles tagged **Kentucky + School**                  |

The worker API interprets these tag combinations from the
`isKentucky`, `category`, and `county` fields produced during
classification.

## Important Note on Sources

Do **not** assume a publication covers only one region based on its
primary market.  For example, lex18.com is based in Lexington but
publishes statewide and out‑of‑state stories.  Every article must be
evaluated individually — no source should carry default tags.
