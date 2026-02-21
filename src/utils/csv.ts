import Papa from 'papaparse'
import { CATEGORY_ORDER } from '../constants'
import type { FlightRecord, ParsedCsvResult } from '../types'

type RawCsvRow = Record<string, string>

const HEADER_ALIASES: Record<string, string[]> = {
  CATEGORIA_CLASIFICACION: ['CATEGORIACLASIFICACION'],
  tipo: ['TIPO'],
  FECHA: ['FECHA'],
  HORA: ['HORA'],
  'CÍA': ['CIA', 'CA'],
  DSCIA: ['DSCIA'],
  CDOCIA: ['CDOCIA'],
  VUELO: ['VUELO'],
}

const normalizeHeader = (header: string): string => {
  return header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
}

const normalizeCell = (value: unknown): string => {
  return String(value ?? '').trim()
}

const buildFlightKey = (row: Pick<FlightRecord, 'fecha' | 'hora' | 'cdocia' | 'vuelo' | 'categoriaClasificacion'>): string => {
  return [row.fecha, row.hora, row.cdocia, row.vuelo, row.categoriaClasificacion]
    .map((part) => part.trim().toUpperCase())
    .join('|')
}

const orderCategories = (categories: string[]): string[] => {
  const indexByCategory = new Map<string, number>(CATEGORY_ORDER.map((category, index) => [category, index]))
  return [...categories].sort((a, b) => {
    const aIndex = indexByCategory.get(a) ?? Number.POSITIVE_INFINITY
    const bIndex = indexByCategory.get(b) ?? Number.POSITIVE_INFINITY
    if (aIndex !== bIndex) {
      return aIndex - bIndex
    }
    return a.localeCompare(b)
  })
}

export async function parseFlightsCsv(file: File): Promise<ParsedCsvResult> {
  const text = await file.text()

  const parsed = Papa.parse<RawCsvRow>(text, {
    header: true,
    skipEmptyLines: 'greedy',
  })

  if (parsed.errors.length > 0) {
    const firstError = parsed.errors[0]
    throw new Error(`CSV invalido (${firstError.message})`)
  }

  const availableHeaders = parsed.meta.fields ?? []
  const headerLookup = new Map<string, string>()
  for (const header of availableHeaders) {
    headerLookup.set(normalizeHeader(header), header)
  }

  const mappedHeaders: Record<string, string> = {}
  for (const [expectedKey, aliases] of Object.entries(HEADER_ALIASES)) {
    const foundHeader = aliases.map((alias) => headerLookup.get(alias)).find(Boolean)
    if (!foundHeader) {
      throw new Error(`Falta la columna requerida: ${expectedKey}`)
    }
    mappedHeaders[expectedKey] = foundHeader
  }

  const flightsByKey = new Map<string, FlightRecord>()
  const categories = new Set<string>()

  for (const row of parsed.data) {
    const categoriaClasificacion = normalizeCell(row[mappedHeaders.CATEGORIA_CLASIFICACION])
    const tipo = normalizeCell(row[mappedHeaders.tipo])
    const fecha = normalizeCell(row[mappedHeaders.FECHA])
    const hora = normalizeCell(row[mappedHeaders.HORA])
    const cia = normalizeCell(row[mappedHeaders['CÍA']])
    const dscia = normalizeCell(row[mappedHeaders.DSCIA])
    const cdocia = normalizeCell(row[mappedHeaders.CDOCIA])
    const vuelo = normalizeCell(row[mappedHeaders.VUELO])

    if (!categoriaClasificacion || !tipo || !fecha || !hora || !cia || !dscia || !cdocia || !vuelo) {
      continue
    }

    const baseFlight: Omit<FlightRecord, 'id' | 'flightKey'> = {
      datasetId: null,
      categoriaClasificacion,
      tipo,
      fecha,
      hora,
      cia,
      dscia,
      cdocia,
      vuelo,
      operated: false,
      operatedAt: null,
      operatedByEmail: null,
    }

    const flightKey = buildFlightKey(baseFlight)
    if (flightsByKey.has(flightKey)) {
      continue
    }

    flightsByKey.set(flightKey, {
      id: crypto.randomUUID(),
      flightKey,
      ...baseFlight,
    })
    categories.add(categoriaClasificacion)
  }

  const flights = [...flightsByKey.values()].sort((a, b) => {
    const dateComparison = a.fecha.localeCompare(b.fecha)
    if (dateComparison !== 0) {
      return dateComparison
    }
    const timeComparison = a.hora.localeCompare(b.hora)
    if (timeComparison !== 0) {
      return timeComparison
    }
    return a.vuelo.localeCompare(b.vuelo)
  })

  return {
    flights,
    categories: orderCategories([...categories]),
  }
}
