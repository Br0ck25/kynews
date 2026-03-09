# Automated Kentucky Weather News System

### Technical Specification

Build a system that automatically detects severe weather products from
NOAA and the Storm Prediction Center, generates articles, publishes them
to a news website, and posts them to Facebook.

The system must detect updates within **30--60 seconds** of release.

------------------------------------------------------------------------

# 1. System Architecture

Components:

1.  Alert ingestion service\
2.  SPC RSS ingestion service\
3.  Article generator\
4.  Website publishing API integration\
5.  Radar and map embedding\
6.  Duplicate prevention\
7.  Scheduler / cron worker

All services can run inside a **single Node.js worker**.

Polling interval: **60 seconds**

------------------------------------------------------------------------

# 2. Data Sources

## 2.1 National Weather Service Alerts API

Endpoint

    https://api.weather.gov/alerts/active?area=KY

Purpose

Detect:

-   Tornado warnings
-   Severe thunderstorm warnings
-   Flood warnings
-   Watches
-   Advisories

Important fields

    alert.id
    alert.properties.event
    alert.properties.headline
    alert.properties.description
    alert.properties.areaDesc
    alert.properties.instruction
    alert.properties.sent
    alert.geometry

------------------------------------------------------------------------

## 2.2 Storm Prediction Center RSS Feed

Endpoint

    https://www.spc.noaa.gov/products/spcrss.xml

Detects:

-   Mesoscale discussions
-   Tornado watches
-   Severe thunderstorm watches
-   Convective outlook updates
-   Fire weather outlooks

Important RSS fields

    item.title
    item.link
    item.description
    item.pubDate

------------------------------------------------------------------------

## 2.3 SPC Full Discussion Text

Convert `.html` links to `.txt`

Example

    https://www.spc.noaa.gov/products/md/md0215.html

becomes

    https://www.spc.noaa.gov/products/md/md0215.txt

Use this to embed the full meteorologist discussion.

------------------------------------------------------------------------

# 3. Polling Worker

Run continuously.

Interval:

    60 seconds

Tasks each cycle:

1.  Check NWS alerts API
2.  Check SPC RSS feed
3.  Detect new items
4.  Generate articles
5.  Publish to website
6.  Post to Facebook

------------------------------------------------------------------------

# 4. Duplicate Prevention

Maintain persistent storage of processed IDs.

Options:

-   SQLite
-   Redis
-   JSON file
-   database table

Store:

    processed_alert_ids
    processed_spc_links

Before publishing, check if item already exists.

------------------------------------------------------------------------

# 5. Article Generation

Each detected item becomes a structured article.

### Article Schema

``` json
{
  "title": "string",
  "slug": "string",
  "content": "string",
  "category": "weather",
  "published_at": "datetime"
}
```

Slug generation rules:

-   lowercase
-   replace spaces with hyphens
-   remove special characters

------------------------------------------------------------------------

# 6. NWS Alert Article Template

Title

    {EVENT} Issued for {COUNTIES}

Example

    Tornado Warning Issued for Perry and Leslie Counties

Content template

    The National Weather Service has issued a {EVENT} for the following areas:

    {COUNTIES}

    Issued at:
    {TIME}

    Details:
    {DESCRIPTION}

    Instructions:
    {INSTRUCTION}

    Residents in the warned area should monitor local conditions and follow guidance from emergency officials.

Include radar image below the text.

------------------------------------------------------------------------

# 7. SPC Article Template

Title

    {TITLE} – Storm Prediction Center Update

Content

    The Storm Prediction Center has issued a new weather update affecting portions of the region.

    Summary:
    {DESCRIPTION}

    Full meteorologist discussion:

    {FULL_TEXT}

    More updates will be provided as additional information becomes available.

------------------------------------------------------------------------

# 8. Radar Embedding

Embed radar GIF in every weather article.

Kentucky regional radar

    https://radar.weather.gov/ridge/standard/KLVX_loop.gif

Eastern Kentucky radar

    https://radar.weather.gov/ridge/standard/KJKL_loop.gif

Embed HTML

``` html
<img src="RADAR_URL" alt="Weather Radar">
```

------------------------------------------------------------------------

# 9. Alert Polygon Map

If alert contains geometry data:

    alert.geometry

Store GeoJSON and render with Leaflet on article pages.

Leaflet example

``` javascript
L.geoJSON(alert.geometry).addTo(map)
```

------------------------------------------------------------------------

# 10. Website Publishing API

POST endpoint

    POST https://localkynews.com/api/articles/create

Request body

``` json
{
  "title": "string",
  "slug": "string",
  "content": "string",
  "category": "weather"
}
```

Headers

    Content-Type: application/json

------------------------------------------------------------------------

# 11. Example Workflow

1.  NWS issues tornado warning.
2.  NOAA updates API.
3.  Worker detects new alert.
4.  Article is generated.
5.  Radar image added.
6.  Article published to site.

Total time:

    30–60 seconds

------------------------------------------------------------------------