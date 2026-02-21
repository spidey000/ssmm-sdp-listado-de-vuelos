export type AppMode = 'guest' | 'supabase'
export type ServiceFlag = 'ATENDER' | 'NO_ATENDER'

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
  serviceFlag: ServiceFlag | null
  serviceFlagSource: 'auto' | 'manual' | null
  serviceFlagUpdatedAt: string | null
  serviceFlagUpdatedByEmail: string | null
  serviceFlagRunId: string | null
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

export interface AutoAssignmentSummary {
  category: string
  total: number
  targetPercent: number
  requiredCount: number
  assignedCount: number
}

export interface AutoAssignmentResult {
  runId: string
  seed: string
  workDate: string
  updatedFlights: number
  summary: AutoAssignmentSummary[]
}
