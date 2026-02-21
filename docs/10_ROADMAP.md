# Roadmap

## Timeline (Single Developer)

| Milestone | Target | Build Scope | Exit Criteria |
|---|---|---|---|
| M0 Baseline | Week 1 | Canonical app paths, schema alignment, docs baseline | One canonical web/API path, no structural blockers |
| M1 Kentucky Core | Weeks 2-3 | KY nav polish, list reliability, reader/read-later hardening | KY browsing stable on mobile |
| M2 National Lane | Week 4 | National feeds + dedicated `/national` lane | National stories visible without polluting KY filters |
| M3 Weather Hub | Week 5 | NWS forecast + alerts + weather screen | County weather and alerts operational |
| M4 Lost & Found MVP | Weeks 6-7 | Submission, media upload, moderation endpoints | Submit -> moderate -> publish works |
| M5 PWA Hardening | Week 8 | Offline and update UX polish, cache tuning | PWA installable and resilient offline |
| M6 Cloudflare Migration | Weeks 9-10 | Worker + D1 + R2 parity | Staging cloud parity achieved |
| M7 Launch Readiness | Week 11 | Runbooks, dashboards, QA, content governance | Soft launch go/no-go checklist complete |

## Priority Queue
1. Stabilize all new endpoints with basic smoke tests.
2. Add weather severity banner on Today/Kentucky.
3. Add admin UI shell for moderation and feed diagnostics.
4. Implement Cloudflare worker parity and deployment automation.
5. Complete policy pages and legal/compliance baseline.

## Definition of Done (Launch)
- KY + National + Weather + Lost & Found are functional in production.
- Ingestion and weather jobs are monitored and alerting.
- Moderation SLA and escalation process documented.
- PWA install/update behavior validated on major mobile browsers.
