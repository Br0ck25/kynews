# County Info Page Blueprint

This document describes the structure, styling, and test conventions used for the Leslie County
`government offices` and `utilities` pages. These pages serve as the template for all
future county-specific information dialogs in the application.

Whenever you need to add a new county, follow these patterns.

---

## 1. Data file structure (`src/data/countyInfo.js`)

Each county entry lives under `countyInfo` with two keys: `government` and `utilities`.
Leslie County hardcodes JSX; other counties may render placeholder text.

### Government (`leslieGov`)

1. **Heading & intro**: an `<h4>` with the full title plus a paragraph.
2. **Quick links**: series of `<Button>` components (outlined/primary/sizeSmall) that:
   - Either open an external `href` in a new tab (`target="_blank" rel="noopener noreferrer"`),
     or scroll within the dialog when `href` begins with `#`.
   - Disabled buttons for contact-only info.
   - Click handler for hash targets uses `document.getElementById(id).scrollIntoView({behavior:'smooth'})`.
3. **Sections**: each section heading uses `<Typography variant="h6" style={sectionHeadingStyle}`
   and may include an `id` when targeted by quick links.
4. **Cards**: each entry uses a `<Card style={cardStyle}>` containing a `<CardContent>` with
   `<Typography variant="body2">` and plain HTML for details. Addresses and phone numbers
   are wrapped in `<a>` tags as `tel:` or Google Maps links.

**Styling constants** `cardStyle` and `sectionHeadingStyle` are defined at top of file.

### Utilities (`leslieUtils`)

1. Similar heading/intro.
2. Quick-links block identical layout; targets correspond to ids on utility sections.
3. Sections appear in logical order: electric, natural gas, water & sewer, trash & waste,
   internet/phone/TV, followed by broadband resources.
4. Each provider rendered in its own card with clickable address, phone, website links.

Reciprocal navigation boxes at the bottom link to the counterpart page without opening a new tab.

---

## 2. Routing and rendering

- `county-page.js` reads `countyInfo` and determines whether to display buttons for a given
  county slug. Leslie is special-cased by name.
- When an info dialog is opened (`/news/kentucky/:countySlug/:infoType`), `CountyInfoPage` renders
  the JSX from `countyInfo[countySlug]` and wraps it in sections.

---

## 3. Tests (`src/pages/county-page.test.js`)

Add or update tests whenever you modify layout/content.

### General patterns

- Render `KentuckyNewsPage` or `CountyInfoPage` inside a `MemoryRouter` with a `Provider`.
- Assert existence of navigation buttons, dialog behavior, reciprocal links, and quick links.

### Content-specific assertions

- Use `screen.findByText` for headings present after rendering.
- Validate all clickable addresses using `.closest('a')` with the proper `href`.
- For quick links/scrolling, mock `HTMLElement.prototype.scrollIntoView` and assert calls on click.
- Verify reciprocal links point to the correct path; absence of `target` for in-dialog nav.

### Adding new county tests

1. Create a new test block analogous to those for Leslie:
   - `test('X county content updates…', async () => {...});`
2. Include any assertions for new quick links, addresses, or other county-specific sections.

---

## 4. Styling notes

- Use Material‑UI components consistently.
- Keep `cardStyle` universal; adjust only if county requires visual distinction.
- Use `Typography` variants h4/h6/body2 as shown.

---

## 5. Extending to other counties

To scaffold a new county:

1. Add an entry to `countyInfo` with empty or placeholder JSX.
2. Duplicate Leslie's sections and replace data with the new county's details.
3. Ensure quick links target existing section IDs or add new ones as needed.
4. Update routing tests for slug and info types if necessary.

This blueprint ensures all county pages maintain consistent layout, navigation, and accessibility.
Whenever you ask to create pages for another county, refer back to this file for guidance.
