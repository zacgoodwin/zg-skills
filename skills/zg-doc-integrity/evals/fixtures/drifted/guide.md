# Widget Service Guide

## Quickstart

Install the client, set your API key, and make a request.

```bash
export WIDGET_API_KEY=sk-...
widget call --timeout 30s
```

The request timeout is 30s by default. Raise it for slow endpoints.

You must run migrations before deploying. The service will not start against a
schema older than the binary expects.

## Authentication

Every request carries an **API key**. An API key is a long-lived credential
scoped to one project; it never expires on its own and must be rotated by hand.

Keys are passed in the `Authorization` header. A key that has been revoked
returns 401 immediately.

## Retry behaviour

The client retries failed requests using a retry budget. The retry budget is the
number of attempts the client may spend on a single logical request, including
the first.

The default retry budget is 3. You should not set it above 10.

A retry is only attempted for a 5xx response or a network error. You must never
retry a 4xx.

## Rate limits

The free tier allows 100 requests per minute. The paid tier allows 1000 requests
per minute.

Requests beyond the limit receive 429. See [the reference](reference.md#errors)
for the full error table.

## Deployment

Shipping on a Friday afternoon is fine as long as someone is around to watch it.

You must run migrations before deploying.

## Examples

### Anti-pattern: retrying a 4xx

```python
# Do NOT do this.
while resp.status == 400:
    resp = client.call()
```

Never retry a 4xx. This example exists to show what the client does not do.

## Changelog

### v1.2.0

The request timeout was raised from 10s to 30s.

### v1.0.0

The retry budget was 5. Rate limits did not exist.
