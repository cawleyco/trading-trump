Approvals is the manual-review queue: when a strategy in **manual approval** mode matches a trade, the proposed order waits here — with its thesis card — until you decide. Nothing trades from this page without your click.

## How to review a pending approval

1. Each pending card shows what matched: the strategy name, the politician and trade that triggered it, and the proposed order (direction, notional dollars, ticker, target fund) with its **expiry time**.
2. Read the attached thesis card — what happened, why it might matter, price drift since, the score/confidence/recommendation, and the risks.
3. Click **Approve** to send the proposed order into the normal risk pipeline (it can still be rejected there — approval is consent, not a bypass), or **Reject** to drop it.

## How to see past decisions

Switch the **Status** filter between Pending, Approved, Rejected, and Expired. Expired means the approval's window passed before anyone acted — matches go stale by design, since a disclosure-lagged trade only gets staler.

## Tips & caveats

- Approvals are per-fund: the proposed order targets the fund named in the strategy's action.
- An empty pending queue usually means no strategy is in manual mode, or none has matched yet — check the Strategies page.
- Approving in dry-run mode records a simulated order; in live mode it's real money through the real pipeline.
