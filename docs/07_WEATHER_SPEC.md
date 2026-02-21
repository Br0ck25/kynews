# Weather Specification

## Source of Truth
- NOAA / National Weather Service API (`api.weather.gov`).

## Forecast Flow
1. Resolve KY county zone by name.
2. Resolve county geometry centroid.
3. Fetch point metadata from `/points/{lat},{lon}`.
4. Use forecast URL from points response.
5. Cache normalized forecast in `weather_forecasts`.

## Alert Flow
1. Fetch active alerts for KY from `/alerts/active?area=KY`.
2. Filter by county name (if county provided).
3. Cache alert payloads in `weather_alerts`.
4. Purge old alerts (>48h).

## API Contracts
- `GET /api/weather/forecast?state=KY&county=<county>`
- `GET /api/weather/alerts?state=KY&county=<county>`

## UX Rules
- Weather defaults to My Local county.
- Display active alert cards above forecast blocks.
- If live fetch fails and cache exists, return stale payload with warning.

## Refresh Cadence
- On-demand via route requests (current implementation).
- Planned scheduled refresh every 10 minutes in cloud runtime.

## Known Constraints
- County matching is string-based; naming mismatches can cause misses.
- NWS latency can vary; stale fallback is required for resilience.
