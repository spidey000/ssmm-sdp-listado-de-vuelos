export type AppMode = 'guest' | 'supabase'

export interface FlightRecord {
  id: string
  datasetId: string | null
  flightKey: string
  categoriaClasificacion: string
  tipo: string
  fecha: string
  hora: string
  cia: string
  dscia: string
  cdocia: string
  vuelo: string
  operated: boolean
  operatedAt: string | null
  operatedByEmail: string | null
}

export interface ParsedCsvResult {
  flights: FlightRecord[]
  categories: string[]
}

export interface CategoryProgress {
  category: string
  total: number
  operated: number
  targetPercent: number
  minimumRequired: number
  remaining: number
  operatedPercent: number
  achieved: boolean
}

export interface DatasetSummary {
  id: string
  name: string
  createdAt: string
}
