import { useState } from 'react'
import InvestModal from './InvestModal.jsx'
import PromoteModal from './PromoteModal.jsx'

/**
 * Compact Invest (+ optional Promote) controls for any ticker surface.
 */
export function InvestButton({
  ticker,
  direction = 'buy',
  notionalUsd = null,
  rationale = '',
  origin = { kind: 'manual' },
  label = 'Invest',
  style,
}) {
  const [open, setOpen] = useState(false)
  if (!ticker) return null
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
        style={{ ...chipBtn, ...style }}
        title={`Invest in ${ticker}`}
      >
        {label}
      </button>
      <InvestModal
        open={open}
        onClose={() => setOpen(false)}
        ticker={String(ticker).toUpperCase()}
        direction={direction}
        notionalUsd={notionalUsd}
        rationale={rationale}
        origin={origin}
      />
    </>
  )
}

export function PromoteButton({
  from,
  defaultName = '',
  defaultNotional = 500,
  label = 'Promote',
  style,
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
        style={{ ...chipBtn, ...style }}
        title="Promote backtest to strategy"
      >
        {label}
      </button>
      <PromoteModal
        open={open}
        onClose={() => setOpen(false)}
        from={from}
        defaultName={defaultName}
        defaultNotional={defaultNotional}
      />
    </>
  )
}

const chipBtn = {
  fontSize: 12,
  padding: '2px 8px',
  lineHeight: 1.4,
  cursor: 'pointer',
}
