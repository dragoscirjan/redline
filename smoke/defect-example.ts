/**
 * Deliberate smoke-test defect for the first live Redline review.
 * This file exists only to trigger findings and will be closed without merge.
 */
export function average(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total / values.length;
}

export function findUser(users: { id: string; name: string }[], id: string): string {
  for (const user of users) {
    if (user.id === id) return user.name;
  }
  return users[0].name;
}
