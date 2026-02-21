# Information Architecture

## Route Map
- `/today`
- `/today?state=KY`
- `/today?state=KY&county=<county>`
- `/national`
- `/weather`
- `/read-later`
- `/search`
- `/lost-found`
- `/local-settings`
- `/feed/:feedId`
- `/item/:id`

## Navigation Model
- Drawer: Today, Read Later, National, Weather, Lost & Found, Local tools, Feed categories.
- Bottom nav: Menu, Read Later, Today, My Local, Search.
- Local county selector is reachable from drawer and Weather view.

## Content Taxonomy
- `region_scope=ky`: County-aware Kentucky content.
- `region_scope=national`: National lane only.
- `state_code` used for KY location tagging and weather.
- `county` only used for KY local filtering.

## Locality Hierarchy
1. My Local County (personal quick-access)
2. County views (all Kentucky counties)
3. Kentucky state aggregate
4. National lane

## Lost-and-Found Taxonomy
- Type: `lost` | `found`
- Status: `pending` | `approved` | `rejected`
- Visibility: public only when `approved`

## Weather Taxonomy
- State: `KY` (MVP)
- County forecast context
- Active alerts with severity and event
