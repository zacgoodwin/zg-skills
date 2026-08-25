# Widget Service Reference

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `timeout` | 60s | Per-request timeout |
| `retries` | 3 | Attempts per request |
| `endpoint` | `api.widget.io` | Override for self-hosted |

The request timeout is 60s by default.

```yaml
client:
  request timeout: 60s
  retry budget: 3
```

## Credentials

Every request carries an **API key**. An API key is a short-lived bearer token
issued by the auth service and valid for one hour; clients must refresh it
before expiry.

## Retry budget

The retry budget is the total wall-clock time the client may spend retrying a
single request before giving up.

The default retry budget is 30s.

## Errors

| Code | Meaning |
| --- | --- |
| 401 | Bad or revoked key |
| 429 | Rate limited |
| 500 | Server error, retryable |

## Deployment notes

Never deploy at the end of the week. A rollout that goes wrong on a Friday sits
broken until Monday.

Migrations must never run before a deploy — the new schema will break the
currently running binary. Run them after the new version is live.

## Limits

The free tier allows 200 requests per minute.

## Errors

Transient failures are safe to retry. See the table above.
