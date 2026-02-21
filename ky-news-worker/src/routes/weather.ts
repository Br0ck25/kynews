import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../types";
import { badRequest } from "../lib/errors";
import { getWeatherAlerts, getWeatherForecast } from "../services/weather";

const WeatherForecastQuery = z.object({
  state: z.string().length(2).default("KY"),
  county: z.string().min(2).max(80)
});

const WeatherAlertsQuery = z.object({
  state: z.string().length(2).default("KY"),
  county: z.string().min(2).max(80).optional()
});

function queryInput(c: any): Record<string, unknown> {
  const params = new URL(c.req.url).searchParams;
  return Object.fromEntries(params.entries());
}

export function registerWeatherRoutes(app: Hono<AppBindings>): void {
  app.get("/api/weather/forecast", async (c) => {
    const parsed = WeatherForecastQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const out = await getWeatherForecast(c.env, {
      state: parsed.data.state,
      county: parsed.data.county
    });
    c.header("Cache-Control", "public, max-age=120, s-maxage=300, stale-while-revalidate=300");
    return c.json(out);
  });

  app.get("/api/weather/alerts", async (c) => {
    const parsed = WeatherAlertsQuery.safeParse(queryInput(c));
    if (!parsed.success) badRequest("Invalid query");

    const out = await getWeatherAlerts(c.env, {
      state: parsed.data.state,
      county: parsed.data.county
    });
    c.header("Cache-Control", "public, max-age=60, s-maxage=120, stale-while-revalidate=180");
    return c.json(out);
  });
}
