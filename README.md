# PWA Blog template using ReactJs and Material UI

This is a template PWA - Progresive Web Application that uses ReactJs and Material UI. <br/>
App works offline by saving responses in localStorage. <br/>
Currently I've done the development in a subfolder ('/pwa/'). To run in the root folder just remove the ("homepage": "/pwa/",) in the package.json file. (Also remove the "set HOST=intranet&& " from scripts->start property in package.json)

<b>Store is now managed by React-Redux.</b>
<del>Store is managed using React's Context API. </del><br/>
<i>Switch to <b>"react-context"</b> branch to see the React-Contex version</i><br/>

<i>(Posts are being retrieved from a wordpress site using the WordPress REST API)</i>

Steps to install and start playing with the project:

1. git clone https://github.com/edisonneza/react-blog.git
2. npm i
3. npm run start

To generate build files (by removing the source map files) 

* npm run winBuild
<br/>
or <i>(if LINUX)</i>

* npm run build

See GIFs below on desktop and mobile devices:

![desktop version](preview_images/tech_news_en_desktop.gif)

![mobile version](preview_images/tech_news_en_mobile.gif)

## Facebook Auto-Posting

The worker now includes helpers for generating Facebook post captions from
article records and a minimal API surface that can be wired into an
scheduler or admin UI. The logic is intentionally Kentucky‑centric: it
returns a blank string for national articles so that automated routines
can skip those.

### Generating captions

Use the shared utility (frontend `src/utils/functions.js` or worker
`worker/src/lib/facebook.ts`) to create a caption string. It takes an
article object with fields like `title`, `summary`, `county`, `city`,
`category` and will:

1. Clean the headline of branding/trailing junk.
2. Produce a 1‑sentence hook from the summary (40‑word limit).
3. Prefix the hook with the county if not already present.
4. Append a `Read more:` link and a couple of hashtags (`#<County>County`,
   `#KentuckyNews`).

You can call the new Worker endpoint `/api/admin/facebook/caption` with a
JSON body `{ "id": <articleId> }` to retrieve the caption for an
existing article. Only administrators may use this endpoint.

### Posting to Facebook

A companion endpoint `/api/admin/facebook/post` accepts the same body and
will format a caption then send it to the Graph API. The request will
fail with a 500 status if the necessary environment variables are not
set:

* `FACEBOOK_PAGE_ID` – the numeric ID of the target page
* `FACEBOOK_PAGE_ACCESS_TOKEN` – a page access token with `publish_pages`
  permission

For local development, placeholders for these variables are shown in the
`.env` file; actual secrets should be added via `wrangler secret` or the
Pages dashboard instead of in source control.

Rules

* Only Kentucky articles (county or isKentucky flag) are posted.
* National articles yield an empty caption and are ignored.

You’re free to call these endpoints from a CRON job, GitHub Action, or
any other scheduler that discovers new articles as they arrive.

## Cloudflare Deployment Notes

This project uses a separate Cloudflare Worker to serve the `/api/articles` endpoints
that the front‑end consumes. When running locally the Worker runs on `localhost` and the
SPA fetches from a relative path, but after publishing to **Cloudflare Pages** you have two
options:

1. **Route the Worker under the Pages domain.** Add a route in
   `worker/wrangler.jsonc` such as:
   ```jsonc
   "routes": ["kynews.pages.dev/api/*"]
   ```
   then deploy the Worker with `cd worker && npx wrangler publish`. Requests made by the
   site to `/api/...` will automatically hit the Worker, so you don’t need any extra
   configuration.

2. **Use an explicit base URL.** Set the environment variable
   `REACT_APP_API_BASE_URL` for your Pages project (or in `.env` for local testing) to
the full origin of the Worker (e.g. `https://<your-worker-subdomain>.workers.dev`). The
   front‑end will prepend this value when constructing API routes. This approach works
   whether the Worker is routed or not, as long as the variable points at the deployed
   Worker.

If the site is published without either of these, the build will succeed but the
client-side code will still call `/api/articles` on the Pages host, which will return
404 and result in an empty post list. That’s why your production site was blank.

Adjust the Pages build settings to add the environment variable and/or deploy the
Worker before publishing the site.

