import { ValidationError } from './errors.js'

export function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new ValidationError(`${field} must not be empty`)
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return trimmed
}

export function optionalBoundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return boundedString(value, field, max)
}

/** For fields where empty is a real value, not an omission: a card or milestone with no
 * description yet. `optionalBoundedString` rejects '' — which made such cards
 * unsyncable — while omitting the field would silently keep the previous text. */
export function emptyableBoundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ValidationError(`${field} must be at most ${max} characters`)
  return trimmed
}

export function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`)
  if (value.length > maxItems) throw new ValidationError(`${field} must have at most ${maxItems} entries`)
  return value.map((entry, index) => boundedString(entry, `${field}[${index}]`, maxLength))
}

export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive integer`)
  }
  return value
}
