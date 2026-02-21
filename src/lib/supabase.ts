import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from '@supabase/supabase-js'
import type { DatasetSummary, FlightRecord } from '../types'

interface DatasetRow {
  id: string
  name: string
  created_at: string
}

interface FlightRow {
  id: string
  dataset_id: string
  flight_key: string
  categoria_clasificacion: string
  tipo: string
  fecha: string
  hora: string
  cia: string
  dscia: string
  cdocia: string
  vuelo: string
  operated: boolean
  operated_at: string | null
  operated_by_email: string | null
}

interface CategoryTargetRow {
  category: string
  target_percent: number
}

interface DatasetSettingsRow {
  work_date: string
}

type RealtimeStatus = 'SUBSCRIBED' | 'CLOSED' | 'CHANNEL_ERROR' | 'TIMED_OUT'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''

let client: SupabaseClient | null = null

const mapFlightRow = (row: FlightRow): FlightRecord => ({
  id: row.id,
  datasetId: row.dataset_id,
  flightKey: row.flight_key,
  categoriaClasificacion: row.categoria_clasificacion,
  tipo: row.tipo,
  fecha: row.fecha,
  hora: row.hora,
  cia: row.cia,
  dscia: row.dscia,
  cdocia: row.cdocia,
  vuelo: row.vuelo,
  operated: row.operated,
  operatedAt: row.operated_at,
  operatedByEmail: row.operated_by_email,
})

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const isMissingTableError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const err = error as { code?: string; message?: string }
  if (err.code === 'PGRST205' || err.code === '42P01') {
    return true
  }

  if (typeof err.message === 'string' && err.message.toLowerCase().includes('dataset_settings')) {
    return true
  }

  return false
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey)
}

export function getSupabaseClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error('Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY')
  }

  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey)
  }

  return client
}

export async function getCurrentSession(): Promise<Session | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.getSession()
  if (error) {
    throw error
  }
  return data.session
}

export function onAuthChange(callback: (event: AuthChangeEvent, session: Session | null) => void): () => void {
  const supabase = getSupabaseClient()
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session)
  })
  return () => {
    subscription.unsubscribe()
  }
}

export async function isEmailAllowed(email: string): Promise<boolean> {
  const supabase = getSupabaseClient()
  const normalizedEmail = normalizeEmail(email)

  const rpcResult = await supabase.rpc('is_email_allowed', { p_email: normalizedEmail })
  if (rpcResult.error) {
    throw rpcResult.error
  }

  return Boolean(rpcResult.data)
}

export async function requestOtp(email: string): Promise<void> {
  const supabase = getSupabaseClient()
  const normalizedEmail = normalizeEmail(email)

  const allowed = await isEmailAllowed(normalizedEmail)
  if (!allowed) {
    throw new Error('Email no autorizado para recibir OTP')
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: window.location.origin,
    },
  })

  if (error) {
    throw error
  }
}

export async function verifyOtp(email: string, token: string): Promise<void> {
  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.verifyOtp({
    email: normalizeEmail(email),
    token: token.trim(),
    type: 'email',
  })
  if (error) {
    throw error
  }
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient()
  const { error } = await supabase.auth.signOut()
  if (error) {
    throw error
  }
}

export async function listDatasets(limit = 15): Promise<DatasetSummary[]> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('datasets')
    .select('id,name,created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw error
  }

  const rows = (data ?? []) as DatasetRow[]
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }))
}

export async function createDataset(name: string, sourceHash: string): Promise<string> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('datasets')
    .insert({ name, source_hash: sourceHash })
    .select('id')
    .single()

  if (error) {
    throw error
  }

  return data.id as string
}

export async function saveCategoryTargets(datasetId: string, targets: Record<string, number>): Promise<void> {
  const supabase = getSupabaseClient()
  const payload = Object.entries(targets).map(([category, target]) => ({
    dataset_id: datasetId,
    category,
    target_percent: target,
  }))

  const { error } = await supabase.from('category_targets').upsert(payload, {
    onConflict: 'dataset_id,category',
  })

  if (error) {
    throw error
  }
}

export async function saveDatasetSettings(datasetId: string, workDate: string): Promise<void> {
  const supabase = getSupabaseClient()
  const payload = {
    dataset_id: datasetId,
    work_date: workDate,
  }

  const { error } = await supabase.from('dataset_settings').upsert(payload, {
    onConflict: 'dataset_id',
  })

  if (error) {
    throw error
  }
}

export async function insertFlights(datasetId: string, flights: FlightRecord[]): Promise<void> {
  const supabase = getSupabaseClient()
  const payload = flights.map((flight) => ({
    dataset_id: datasetId,
    flight_key: flight.flightKey,
    categoria_clasificacion: flight.categoriaClasificacion,
    tipo: flight.tipo,
    fecha: flight.fecha,
    hora: flight.hora,
    cia: flight.cia,
    dscia: flight.dscia,
    cdocia: flight.cdocia,
    vuelo: flight.vuelo,
    operated: false,
  }))

  const chunkSize = 500
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const chunk = payload.slice(offset, offset + chunkSize)
    const { error } = await supabase.from('flights').insert(chunk)
    if (error) {
      throw error
    }
  }
}

export async function loadDataset(datasetId: string): Promise<{
  flights: FlightRecord[]
  targets: Record<string, number>
  workDate: string | null
  hasSavedConfig: boolean
}> {
  const supabase = getSupabaseClient()

  const [flightsResponse, targetsResponse, settingsResponse] = await Promise.all([
    supabase
      .from('flights')
      .select(
        'id,dataset_id,flight_key,categoria_clasificacion,tipo,fecha,hora,cia,dscia,cdocia,vuelo,operated,operated_at,operated_by_email',
      )
      .eq('dataset_id', datasetId)
      .order('fecha', { ascending: true })
      .order('hora', { ascending: true }),
    supabase.from('category_targets').select('category,target_percent').eq('dataset_id', datasetId),
    supabase.from('dataset_settings').select('work_date').eq('dataset_id', datasetId).maybeSingle(),
  ])

  if (flightsResponse.error) {
    throw flightsResponse.error
  }
  if (targetsResponse.error) {
    throw targetsResponse.error
  }
  if (settingsResponse.error && !isMissingTableError(settingsResponse.error)) {
    throw settingsResponse.error
  }

  const flightsRows = (flightsResponse.data ?? []) as FlightRow[]
  const targetRows = (targetsResponse.data ?? []) as CategoryTargetRow[]
  const settingsRow = (settingsResponse.data ?? null) as DatasetSettingsRow | null
  const workDate = settingsRow?.work_date ?? null
  const hasSavedConfig = targetRows.length > 0 && Boolean(workDate)

  return {
    flights: flightsRows.map(mapFlightRow),
    targets: Object.fromEntries(targetRows.map((row) => [row.category, row.target_percent])),
    workDate,
    hasSavedConfig,
  }
}

export async function markFlightOperated(
  flightId: string,
  operatorEmail: string,
): Promise<FlightRecord | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('flights')
    .update({
      operated: true,
      operated_at: new Date().toISOString(),
      operated_by_email: normalizeEmail(operatorEmail),
    })
    .eq('id', flightId)
    .eq('operated', false)
    .select(
      'id,dataset_id,flight_key,categoria_clasificacion,tipo,fecha,hora,cia,dscia,cdocia,vuelo,operated,operated_at,operated_by_email',
    )
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  return mapFlightRow(data as FlightRow)
}

export async function getDatasetById(datasetId: string): Promise<DatasetSummary | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('datasets')
    .select('id,name,created_at')
    .eq('id', datasetId)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  const row = data as DatasetRow
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  }
}

export function subscribeRealtime(
  datasetId: string,
  onFlightChange: (flight: FlightRecord) => void,
  onTargetChange: (targets: Record<string, number>) => void,
  onSettingsChange: (workDate: string) => void,
  onStatus: (status: RealtimeStatus) => void,
): () => void {
  const supabase = getSupabaseClient()
  const targetState: Record<string, number> = {}

  const channel = supabase
    .channel(`dataset-${datasetId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'flights',
        filter: `dataset_id=eq.${datasetId}`,
      },
      (payload) => {
        if (!payload.new) {
          return
        }
        onFlightChange(mapFlightRow(payload.new as FlightRow))
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'category_targets',
        filter: `dataset_id=eq.${datasetId}`,
      },
      (payload) => {
        if (!payload.new) {
          return
        }
        const row = payload.new as CategoryTargetRow
        targetState[row.category] = row.target_percent
        onTargetChange({ ...targetState })
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'dataset_settings',
        filter: `dataset_id=eq.${datasetId}`,
      },
      (payload) => {
        if (!payload.new) {
          return
        }
        const row = payload.new as DatasetSettingsRow
        if (row.work_date) {
          onSettingsChange(row.work_date)
        }
      },
    )
    .subscribe((status) => {
      onStatus(status as RealtimeStatus)
    })

  return () => {
    void supabase.removeChannel(channel)
  }
}
