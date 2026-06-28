# Operating guide — Acme Orders API gate

You can call the **Acme Orders** API at `http://localhost:3000`. It is
**deny-by-default**: every call needs a **capability token** (a macaroon) that
states which operations you may perform; a proxy enforces it. Your token is
already provisioned for this machine.

## How to behave (read this first)

- A human operator is driving a live demo. **Do exactly what they ask, one step at
  a time.** Do not run ahead, do not chain extra steps, do not try to "set
  everything up."
- **After reading this guide, take no action yet.** Reply that you understand the
  gate, **present the operator with the suggested prompts below** so they can pick
  what to demonstrate, then wait for their instruction.
- Keep replies tight: show the command you ran and the key result. No long
  preambles, no speculation.
- A `403` is almost always the system working as designed (a scoped-out operation,
  a pending human approval, or a revoked token). State plainly what happened and
  why. **Never brute-force retries.**

Your shell has `curl` and `jq`. Load your token once:

```sh
MAC=$(jq -r .macaroon ~/.aboard/session.json)
```

## Suggested prompts — offer these to the operator

When you finish reading this, show the operator these as the things they can ask
you to do. They walk through the agent-authorization service end to end. Do them
**one at a time**, only when asked.

1. **"List the current orders."**
   Reads the API with your scoped capability token.
2. **"Create an order for 5 blue widgets."**
   A write your token is authorized to make.
3. **"Delegate a read-only sub-agent, use it to read the orders, then have it try
   to create one — show me what happens."**
   You narrow your token offline and hand it off; the sub-agent reads fine but is
   denied the write it was never granted (`operation_not_allowed`).
4. **"Delegate a sub-agent whose order creation needs my approval, then have it try
   to create an order."**
   The write returns `approval_required` and waits. The operator approves it in the
   admin portal (Approvals tab); when they confirm, you retry once and it succeeds.
5. **"I revoked the session in the portal — read the orders again."**
   After the operator revokes, every call (yours and any sub-agent's) fails with
   `grant_revoked`.

## Reference — how to do each action (only when asked)

**Discover the service**

```sh
curl -s http://localhost:3000/.well-known/agent-configuration | jq
```

**Read / write the API** (token as Bearer)

```sh
curl -s -H "authorization: Bearer $MAC" http://localhost:3000/orders | jq            # list
curl -s -H "authorization: Bearer $MAC" http://localhost:3000/orders/42 | jq         # read one
curl -s -X POST -H "authorization: Bearer $MAC" -H "content-type: application/json" \
     -d '{"item":"Blue widget","qty":5}' http://localhost:3000/orders | jq           # create
```

**Delegate a read-only sub-agent** (attenuation is keyless — narrow, then hand off)

```sh
SUB=$(curl -s -X POST -H "content-type: application/json" -d '{
        "token": "'"$MAC"'",
        "caveats": [{ "type": "endpoint", "allow": ["GET /orders","GET /orders/*","GET /products"] }]
      }' http://localhost:3000/api/onboarding/grants/attenuate | jq -r .token)
# call with $SUB: GET → 200, POST → 403 (creation is outside its grant)
```

**Delegate a sub-agent whose writes need human approval** (scoped to one operation)

```sh
GATED=$(curl -s -X POST -H "content-type: application/json" -d '{
        "token": "'"$MAC"'",
        "caveats": [{ "type": "approval", "id": "appr-001", "op": "POST /orders",
                      "reason": "creating an order needs sign-off" }]
      }' http://localhost:3000/api/onboarding/grants/attenuate | jq -r .token)
# GET with $GATED → 200; POST → 403 approval_required
```

## What the 403s mean

- `operation_not_allowed` — the token isn't scoped for that operation. Expected for
  a narrowed sub-agent. Report it; don't retry.
- `approval_required` — a human must approve this in the admin portal. **Stop and
  tell the operator the request is awaiting approval.** When they confirm it's
  approved, retry the *same* call **once** — it will succeed. `approval_denied` is
  final; do not retry.
- `grant_revoked` — the session was revoked; this token and every sub-agent token
  from it are dead. Stop and report it.
