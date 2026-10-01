/**
 * Parses the composite action's `timeout` input.
 *
 * GitHub Actions caps a job at 360 minutes, so the parser enforces that cap
 * instead of accepting a value it cannot honor. `1d` is therefore rejected
 * with a validation error rather than clamped.
 */

const MAX_MINUTES = 360;
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_HOUR = 60;

export interface Duration {
  readonly minutes: number;
  readonly milliseconds: number;
}

export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = MAX_MINUTES;

function addComponent(minutes: number, raw: string, scale: number, label: string): number {
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`${label} component is not a non-negative integer`);
  return minutes + Number(raw) * scale;
}

function parseComponents(raw: string): number {
  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/u;
  const match = pattern.exec(raw);
  if (!match) throw new Error('timeout is not a valid duration (examples: 10m, 2h, 1h30m)');
  const [days = '', hours = '', minutesComponent = ''] = match.slice(1) as [string, string, string];
  if (days === '' && hours === '' && minutesComponent === '') {
    throw new Error('timeout is not a valid duration (examples: 10m, 2h, 1h30m)');
  }
  let minutes = 0;
  if (days !== '') minutes = addComponent(minutes, days, MINUTES_PER_DAY, 'day');
  if (hours !== '') minutes = addComponent(minutes, hours, MINUTES_PER_HOUR, 'hour');
  if (minutesComponent !== '') minutes = addComponent(minutes, minutesComponent, 1, 'minute');
  return minutes;
}

export function parseDuration(raw: string, options: { maximumMinutes?: number } = {}): Duration {
  const maximumMinutes = options.maximumMinutes ?? MAX_TIMEOUT_MINUTES;
  if (raw.length === 0 || raw !== raw.trim() || /\s/u.test(raw)) {
    throw new Error('timeout is not a valid duration (examples: 10m, 2h, 1h30m)');
  }
  const minutes = parseComponents(raw);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new Error('timeout must be a positive duration');
  if (minutes > maximumMinutes) {
    throw new Error(`timeout ${raw} exceeds the ${maximumMinutes}-minute cap`);
  }
  return Object.freeze({ minutes, milliseconds: minutes * 60_000 });
}
