import { CATEGORY_ORDER, DEFAULT_TARGETS } from '../constants'
import type { CategoryProgress, FlightRecord } from '../types'

const categorySortIndex = new Map<string, number>(CATEGORY_ORDER.map((category, index) => [category, index]))

export function buildCategoryProgress(
  flights: FlightRecord[],
  targets: Record<string, number>,
): CategoryProgress[] {
  const categories = new Set<string>()

  for (const flight of flights) {
    categories.add(flight.categoriaClasificacion)
  }
  for (const category of Object.keys(targets)) {
    categories.add(category)
  }

  return [...categories]
    .map((category) => {
      const categoryFlights = flights.filter((flight) => flight.categoriaClasificacion === category)
      const total = categoryFlights.length
      const operated = categoryFlights.filter((flight) => flight.operated).length
      const targetPercent = targets[category] ?? DEFAULT_TARGETS[category] ?? 0
      const minimumRequired = total === 0 ? 0 : Math.ceil((total * targetPercent) / 100)
      const remaining = Math.max(0, minimumRequired - operated)
      const operatedPercent = total === 0 ? 0 : (operated / total) * 100

      return {
        category,
        total,
        operated,
        targetPercent,
        minimumRequired,
        remaining,
        operatedPercent,
        achieved: operated >= minimumRequired,
      }
    })
    .sort((a, b) => {
      const aIndex = categorySortIndex.get(a.category) ?? Number.POSITIVE_INFINITY
      const bIndex = categorySortIndex.get(b.category) ?? Number.POSITIVE_INFINITY
      if (aIndex !== bIndex) {
        return aIndex - bIndex
      }
      return a.category.localeCompare(b.category)
    })
}

export function buildInitialTargets(categories: string[]): Record<string, number> {
  const entries = categories.map((category) => [category, DEFAULT_TARGETS[category] ?? 0])
  return Object.fromEntries(entries)
}
