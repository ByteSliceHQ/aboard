// Small presentation helpers. No external deps — uses the platform Intl API.

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' },
]

/** Relative time from an epoch-ms timestamp, e.g. "3 minutes ago". */
export function relativeFromMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  let duration = (ms - Date.now()) / 1000 // seconds, negative = past
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return '—'
}

/** Relative time from an epoch-seconds timestamp. */
export function relativeFromSeconds(seconds: number): string {
  return relativeFromMs(seconds * 1000)
}

/** Absolute UTC string for tooltips, from epoch ms. */
export function absoluteFromMs(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toISOString()
}

/** Shorten an opaque id for table display: keep head + tail. */
export function shortId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}
