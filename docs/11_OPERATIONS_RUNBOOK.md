# Operations Runbook

## Daily Checks
- Verify ingest success in latest `fetch_runs` row.
- Review `fetch_errors` for repeated feed failures.
- Verify weather endpoints return current data.
- Check pending lost-and-found moderation queue size.

## Incident Playbooks

### Ingestion Failure Spike
1. Trigger manual reload: `POST /api/admin/feeds/reload`.
2. Inspect `fetch_errors` for top failing feeds.
3. Disable broken feeds temporarily if needed.
4. Confirm new items flowing again.

### Weather API Outage
1. Confirm endpoint returns stale fallback, not hard failure.
2. Notify operators that data may be stale.
3. Monitor NWS recovery and clear warning status.

### Moderation Backlog
1. Prioritize posts older than 2 hours.
2. Reject obvious spam/unsafe submissions first.
3. Log unusual abuse patterns and add blocks/rate rules.

### Abuse Report Surge
1. Query `lost_found_reports` grouped by `post_id`.
2. Unpublish or reject affected post(s).
3. Document action in `admin_audit_log`.

## Monitoring Metrics
- Ingest success rate.
- New items in last 2 hours (KY and National).
- API route latency and error rate.
- Weather endpoint freshness.
- Lost-and-found queue age.

## Alert Thresholds
- No successful ingest in > 30 minutes.
- API 5xx > 2% for 5 minutes.
- Weather fetch failures for > 30 minutes.
- Pending moderation older than 2 hours.

## Backup and Recovery
- Local: periodic copy of `data/dev.sqlite`.
- Cloud: D1 export schedule + R2 lifecycle policy.
- Validate restore process quarterly.

## Governance
- Keep moderation policy, privacy policy, and terms current.
- Maintain takedown contact and escalation owner.
