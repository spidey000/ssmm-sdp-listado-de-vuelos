import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import './App.css'
import { CATEGORY_ORDER, DEFAULT_TARGETS } from './constants'
import {
  createDataset,
  getCurrentSession,
  insertFlights,
  isSupabaseConfigured,
  listDatasets,
  loadDataset,
  markFlightOperated,
  onAuthChange,
  requestOtp,
  saveCategoryTargets,
  signOut,
  subscribeRealtime,
  verifyOtp,
} from './lib/supabase'
import type { AppMode, CategoryProgress, DatasetSummary, FlightRecord } from './types'
import { parseFlightsCsv } from './utils/csv'
import { buildCategoryProgress, buildInitialTargets } from './utils/progress'

const PAGE_SIZE = 120

const CATEGORY_INDEX = new Map<string, number>(CATEGORY_ORDER.map((category, index) => [category, index]))

const sortCategories = (categories: string[]): string[] => {
  return [...categories].sort((a, b) => {
    const aIndex = CATEGORY_INDEX.get(a) ?? Number.POSITIVE_INFINITY
    const bIndex = CATEGORY_INDEX.get(b) ?? Number.POSITIVE_INFINITY
    if (aIndex !== bIndex) {
      return aIndex - bIndex
    }
    return a.localeCompare(b)
  })
}

const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, Number(value.toFixed(2))))
}

const mergeTargets = (
  categories: string[],
  incomingTargets: Record<string, number>,
): Record<string, number> => {
  const uniqueCategories = sortCategories([...new Set([...categories, ...Object.keys(incomingTargets)])])
  return Object.fromEntries(
    uniqueCategories.map((category) => [category, clampPercent(incomingTargets[category] ?? DEFAULT_TARGETS[category] ?? 0)]),
  )
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return 'Ha ocurrido un error inesperado'
}

const formatDateTime = (value: string | null): string => {
  if (!value) {
    return '--'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('es-ES')
}

const formatDatasetDate = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('es-ES')
}

const realtimeLabel = (status: string): string => {
  switch (status) {
    case 'SUBSCRIBED':
      return 'Sincronizado en tiempo real'
    case 'TIMED_OUT':
      return 'Sincronizacion en timeout'
    case 'CHANNEL_ERROR':
      return 'Error en canal realtime'
    case 'CLOSED':
      return 'Canal realtime cerrado'
    default:
      return status
  }
}

const hashFile = async (file: File): Promise<string> => {
  const arrayBuffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const buildOperatedUpdate = (flight: FlightRecord, operatorEmail: string): FlightRecord => {
  return {
    ...flight,
    operated: true,
    operatedAt: new Date().toISOString(),
    operatedByEmail: operatorEmail,
  }
}

function App() {
  const supabaseConfigured = isSupabaseConfigured()
  const [mode, setMode] = useState<AppMode>(supabaseConfigured ? 'supabase' : 'guest')
  const [session, setSession] = useState<Session | null>(null)

  const [authEmail, setAuthEmail] = useState('')
  const [otpCode, setOtpCode] = useState('')
  const [otpRequested, setOtpRequested] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)

  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null)
  const [activeDatasetName, setActiveDatasetName] = useState('')

  const [flights, setFlights] = useState<FlightRecord[]>([])
  const [targets, setTargets] = useState<Record<string, number>>({ ...DEFAULT_TARGETS })
  const [draftTargets, setDraftTargets] = useState<Record<string, number>>({ ...DEFAULT_TARGETS })

  const [uploaderCollapsed, setUploaderCollapsed] = useState(false)
  const [targetsOpen, setTargetsOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [currentPage, setCurrentPage] = useState(1)

  const [confirmFlight, setConfirmFlight] = useState<FlightRecord | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [markBusy, setMarkBusy] = useState(false)
  const [targetsBusy, setTargetsBusy] = useState(false)
  const [loadingDataset, setLoadingDataset] = useState(false)

  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [realtimeStatus, setRealtimeStatus] = useState('LOCAL')

  const categories = useMemo(() => {
    const categoriesFromFlights = flights.map((flight) => flight.categoriaClasificacion)
    const targetCategories = Object.keys(draftTargets)
    const merged = [...new Set([...categoriesFromFlights, ...targetCategories, ...CATEGORY_ORDER])]
    return sortCategories(merged)
  }, [flights, draftTargets])

  const progress = useMemo<CategoryProgress[]>(() => {
    return buildCategoryProgress(flights, targets)
  }, [flights, targets])

  const filteredFlights = useMemo(() => {
    const normalizedQuery = query.trim().toUpperCase()
    return flights.filter((flight) => {
      if (categoryFilter !== 'all' && flight.categoriaClasificacion !== categoryFilter) {
        return false
      }
      if (!normalizedQuery) {
        return true
      }
      const searchable = [flight.vuelo, flight.dscia, flight.cia, flight.cdocia, flight.fecha, flight.hora]
        .join(' ')
        .toUpperCase()
      return searchable.includes(normalizedQuery)
    })
  }, [flights, categoryFilter, query])

  const totalPages = Math.max(1, Math.ceil(filteredFlights.length / PAGE_SIZE))
  const currentPageSafe = Math.min(currentPage, totalPages)
  const visibleFlights = useMemo(() => {
    const from = (currentPageSafe - 1) * PAGE_SIZE
    return filteredFlights.slice(from, from + PAGE_SIZE)
  }, [filteredFlights, currentPageSafe])

  const totalOperated = useMemo(() => flights.filter((flight) => flight.operated).length, [flights])

  useEffect(() => {
    setCurrentPage(1)
  }, [query, categoryFilter, flights.length])

  useEffect(() => {
    if (mode !== 'supabase' || !supabaseConfigured) {
      setSession(null)
      return
    }

    let active = true

    void getCurrentSession()
      .then((nextSession) => {
        if (active) {
          setSession(nextSession)
        }
      })
      .catch((authError) => {
        if (active) {
          setError(getErrorMessage(authError))
        }
      })

    const unsubscribe = onAuthChange((_event, nextSession) => {
      setSession(nextSession)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [mode, supabaseConfigured])

  const refreshDatasets = useCallback(async (): Promise<void> => {
    if (mode !== 'supabase' || !session) {
      setDatasets([])
      return
    }

    const nextDatasets = await listDatasets()
    setDatasets(nextDatasets)
  }, [mode, session])

  useEffect(() => {
    if (mode !== 'supabase' || !session) {
      setDatasets([])
      return
    }
    void refreshDatasets().catch((refreshError) => {
      setError(getErrorMessage(refreshError))
    })
  }, [mode, session, refreshDatasets])

  useEffect(() => {
    if (mode !== 'supabase' || !session || !activeDatasetId) {
      setRealtimeStatus('LOCAL')
      return
    }

    let active = true
    setLoadingDataset(true)

    void loadDataset(activeDatasetId)
      .then((datasetState) => {
        if (!active) {
          return
        }
        setFlights(datasetState.flights)
        const mergedTargets = mergeTargets(
          datasetState.flights.map((flight) => flight.categoriaClasificacion),
          datasetState.targets,
        )
        setTargets(mergedTargets)
        setDraftTargets(mergedTargets)
        setUploaderCollapsed(true)
      })
      .catch((loadError) => {
        if (active) {
          setError(getErrorMessage(loadError))
        }
      })
      .finally(() => {
        if (active) {
          setLoadingDataset(false)
        }
      })

    const unsubscribeRealtime = subscribeRealtime(
      activeDatasetId,
      (updatedFlight) => {
        setFlights((currentFlights) => {
          const existingIndex = currentFlights.findIndex((flight) => flight.id === updatedFlight.id)
          if (existingIndex === -1) {
            return currentFlights
          }
          const nextFlights = [...currentFlights]
          nextFlights[existingIndex] = updatedFlight
          return nextFlights
        })
      },
      (updatedTargets) => {
        setTargets((currentTargets) => {
          const nextRawTargets = { ...currentTargets, ...updatedTargets }
          const mergedTargets = mergeTargets(Object.keys(nextRawTargets), nextRawTargets)
          setDraftTargets(mergedTargets)
          return mergedTargets
        })
      },
      (status) => {
        setRealtimeStatus(status)
      },
    )

    return () => {
      active = false
      unsubscribeRealtime()
    }
  }, [activeDatasetId, mode, session])

  const resetWorkspace = (nextMode: AppMode): void => {
    setMode(nextMode)
    setFlights([])
    setTargets({ ...DEFAULT_TARGETS })
    setDraftTargets({ ...DEFAULT_TARGETS })
    setActiveDatasetId(null)
    setActiveDatasetName('')
    setUploaderCollapsed(false)
    setNotice('')
    setError('')
    setCategoryFilter('all')
    setQuery('')
    setRealtimeStatus('LOCAL')
  }

  const handleRequestOtp = async (): Promise<void> => {
    if (!authEmail.trim()) {
      setError('Introduce un email valido')
      return
    }

    setAuthBusy(true)
    setError('')
    setNotice('')

    try {
      await requestOtp(authEmail)
      setOtpRequested(true)
      setNotice('OTP enviado. Revisa tu email y escribe el codigo de 6 digitos.')
    } catch (otpError) {
      setError(getErrorMessage(otpError))
    } finally {
      setAuthBusy(false)
    }
  }

  const handleVerifyOtp = async (): Promise<void> => {
    if (!otpCode.trim()) {
      setError('Introduce el codigo OTP')
      return
    }

    setAuthBusy(true)
    setError('')
    setNotice('')

    try {
      await verifyOtp(authEmail, otpCode)
      setNotice('Sesion iniciada correctamente')
      setOtpCode('')
    } catch (verifyError) {
      setError(getErrorMessage(verifyError))
    } finally {
      setAuthBusy(false)
    }
  }

  const handleSupabaseSignOut = async (): Promise<void> => {
    setError('')
    setNotice('')
    try {
      await signOut()
      setSession(null)
      setDatasets([])
      setActiveDatasetId(null)
      setFlights([])
      setUploaderCollapsed(false)
    } catch (signOutError) {
      setError(getErrorMessage(signOutError))
    }
  }

  const handleDatasetSelect = (datasetId: string): void => {
    setActiveDatasetId(datasetId || null)
    const selectedDataset = datasets.find((dataset) => dataset.id === datasetId)
    setActiveDatasetName(selectedDataset?.name ?? '')
  }

  const handleFileSelected = async (file: File | null): Promise<void> => {
    if (!file) {
      return
    }

    setUploadBusy(true)
    setError('')
    setNotice('')

    try {
      const parsed = await parseFlightsCsv(file)
      if (parsed.flights.length === 0) {
        throw new Error('No se han detectado vuelos validos en el CSV')
      }

      const initialTargets = mergeTargets(parsed.categories, buildInitialTargets(parsed.categories))

      if (mode === 'guest') {
        setFlights(parsed.flights)
        setTargets(initialTargets)
        setDraftTargets(initialTargets)
        setActiveDatasetName(file.name)
        setActiveDatasetId(null)
        setUploaderCollapsed(true)
        setNotice(`Archivo cargado en modo guest: ${parsed.flights.length} vuelos`) 
        return
      }

      if (!session?.user.email) {
        throw new Error('Necesitas iniciar sesion OTP antes de subir un CSV')
      }

      const sourceHash = await hashFile(file)
      const datasetId = await createDataset(file.name, sourceHash)
      const flightsWithDataset = parsed.flights.map((flight) => ({
        ...flight,
        datasetId,
      }))

      await saveCategoryTargets(datasetId, initialTargets)
      await insertFlights(datasetId, flightsWithDataset)

      setActiveDatasetId(datasetId)
      setActiveDatasetName(file.name)
      setFlights(flightsWithDataset)
      setTargets(initialTargets)
      setDraftTargets(initialTargets)
      setUploaderCollapsed(true)
      setNotice(`Dataset subido y sincronizado: ${parsed.flights.length} vuelos`) 

      await refreshDatasets()
    } catch (uploadError) {
      setError(getErrorMessage(uploadError))
    } finally {
      setUploadBusy(false)
    }
  }

  const handleDraftTargetChange = (category: string, rawValue: string): void => {
    const numericValue = clampPercent(Number(rawValue))
    setDraftTargets((currentTargets) => ({
      ...currentTargets,
      [category]: numericValue,
    }))
  }

  const handleApplyTargets = async (): Promise<void> => {
    const seedCategories = categories.length > 0 ? categories : [...CATEGORY_ORDER]
    const nextTargets = mergeTargets(seedCategories, draftTargets)

    setTargetsBusy(true)
    setError('')

    try {
      if (mode === 'supabase' && activeDatasetId) {
        await saveCategoryTargets(activeDatasetId, nextTargets)
        setNotice('Porcentajes actualizados para todo el equipo')
      }
      setTargets(nextTargets)
      setDraftTargets(nextTargets)
    } catch (targetsError) {
      setError(getErrorMessage(targetsError))
    } finally {
      setTargetsBusy(false)
    }
  }

  const handleOpenMarkModal = (flight: FlightRecord): void => {
    if (flight.operated) {
      return
    }
    setConfirmFlight(flight)
  }

  const handleConfirmMarkOperated = async (): Promise<void> => {
    if (!confirmFlight) {
      return
    }

    setMarkBusy(true)
    setError('')

    try {
      if (mode === 'guest') {
        const operator = session?.user.email ?? 'guest-test'
        setFlights((currentFlights) =>
          currentFlights.map((flight) =>
            flight.id === confirmFlight.id ? buildOperatedUpdate(flight, operator) : flight,
          ),
        )
        setNotice(`Vuelo ${confirmFlight.vuelo} confirmado como operado (guest)`) 
        setConfirmFlight(null)
        return
      }

      if (!session?.user.email) {
        throw new Error('No hay sesion OTP activa')
      }

      const updatedFlight = await markFlightOperated(confirmFlight.id, session.user.email)
      if (!updatedFlight) {
        setNotice(`El vuelo ${confirmFlight.vuelo} ya fue marcado por otro operador`) 
        setFlights((currentFlights) =>
          currentFlights.map((flight) =>
            flight.id === confirmFlight.id ? buildOperatedUpdate(flight, 'otro-operador') : flight,
          ),
        )
      } else {
        setFlights((currentFlights) =>
          currentFlights.map((flight) => (flight.id === updatedFlight.id ? updatedFlight : flight)),
        )
        setNotice(`Vuelo ${updatedFlight.vuelo} marcado como operado`) 
      }

      setConfirmFlight(null)
    } catch (markError) {
      setError(getErrorMessage(markError))
    } finally {
      setMarkBusy(false)
    }
  }

  const showAuthGate = mode === 'supabase' && !session
  const uploadDisabled = uploadBusy || (mode === 'supabase' && !session)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Control operativo SSMM</p>
          <h1>Seguimiento de vuelos protegidos</h1>
        </div>

        <div className="mode-switch" role="tablist" aria-label="Modo de trabajo">
          <button
            type="button"
            className={mode === 'supabase' ? 'mode-switch__btn active' : 'mode-switch__btn'}
            onClick={() => resetWorkspace('supabase')}
            disabled={!supabaseConfigured}
          >
            Supabase realtime
          </button>
          <button
            type="button"
            className={mode === 'guest' ? 'mode-switch__btn active' : 'mode-switch__btn'}
            onClick={() => resetWorkspace('guest')}
          >
            Guest test
          </button>
        </div>

        <div className="status-panel">
          <span className="status-chip">{mode === 'guest' ? 'Modo local' : realtimeLabel(realtimeStatus)}</span>
          {mode === 'supabase' && session?.user.email ? (
            <>
              <span className="status-chip status-chip--user">{session.user.email}</span>
              <button type="button" className="ghost-btn" onClick={handleSupabaseSignOut}>
                Salir
              </button>
            </>
          ) : null}
        </div>
      </header>

      {mode === 'guest' ? (
        <section className="warning-banner">
          <strong>Guest test activo:</strong> no hay sincronizacion con Supabase. Los cambios solo existen en este navegador.
        </section>
      ) : null}

      {error ? <section className="message message--error">{error}</section> : null}
      {notice ? <section className="message message--ok">{notice}</section> : null}

      {showAuthGate ? (
        <section className="auth-card">
          <h2>Acceso OTP</h2>
          <p>Solo se envia OTP a emails presentes en la tabla de permitidos (`allowed_emails`).</p>
          <div className="auth-row">
            <label htmlFor="authEmail">Email corporativo</label>
            <input
              id="authEmail"
              type="email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              placeholder="operador@empresa.com"
            />
          </div>
          <button type="button" onClick={handleRequestOtp} disabled={authBusy}>
            {authBusy ? 'Enviando...' : 'Enviar OTP'}
          </button>

          {otpRequested ? (
            <>
              <div className="auth-row">
                <label htmlFor="otpCode">Codigo OTP</label>
                <input
                  id="otpCode"
                  type="text"
                  inputMode="numeric"
                  value={otpCode}
                  onChange={(event) => setOtpCode(event.target.value)}
                  placeholder="123456"
                />
              </div>
              <button type="button" className="secondary-btn" onClick={handleVerifyOtp} disabled={authBusy}>
                {authBusy ? 'Verificando...' : 'Validar OTP'}
              </button>
            </>
          ) : null}
        </section>
      ) : (
        <>
          <section className="banner-card">
            <button type="button" className="banner-card__toggle" onClick={() => setTargetsOpen((open) => !open)}>
              Porcentajes de proteccion por categoria {targetsOpen ? '▲' : '▼'}
            </button>
            {targetsOpen ? (
              <div className="targets-grid">
                {categories.map((category) => (
                  <label key={category} className="target-control">
                    <span>{category}</span>
                    <div className="target-control__inputs">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={draftTargets[category] ?? 0}
                        onChange={(event) => handleDraftTargetChange(category, event.target.value)}
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        value={draftTargets[category] ?? 0}
                        onChange={(event) => handleDraftTargetChange(category, event.target.value)}
                      />
                    </div>
                  </label>
                ))}
                <button type="button" onClick={handleApplyTargets} disabled={targetsBusy}>
                  {targetsBusy ? 'Guardando...' : 'Aplicar porcentajes'}
                </button>
              </div>
            ) : null}
          </section>

          {mode === 'supabase' ? (
            <section className="datasets-panel">
              <div>
                <label htmlFor="datasetSelect">Dataset activo</label>
                <select
                  id="datasetSelect"
                  value={activeDatasetId ?? ''}
                  onChange={(event) => handleDatasetSelect(event.target.value)}
                >
                  <option value="">Selecciona un dataset</option>
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name} ({formatDatasetDate(dataset.createdAt)})
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="secondary-btn" onClick={() => void refreshDatasets()}>
                Recargar lista
              </button>
            </section>
          ) : null}

          {flights.length === 0 ? (
            <section className="upload-stage upload-stage--primary">
              <h2>Cargar listado CSV</h2>
              <p>
                Campos minimos esperados: CATEGORIA_CLASIFICACION, tipo, FECHA, HORA, CÍA, DSCIA, CDOCIA, VUELO.
              </p>
              <label className="file-input">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={uploadDisabled}
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0] ?? null
                    void handleFileSelected(selectedFile)
                    event.currentTarget.value = ''
                  }}
                />
                <span>{uploadBusy ? 'Procesando...' : 'Seleccionar CSV'}</span>
              </label>
            </section>
          ) : (
            <>
              {uploaderCollapsed ? (
                <aside className="mini-uploader">
                  <h3>CSV activo</h3>
                  <p title={activeDatasetName}>{activeDatasetName || 'Dataset cargado'}</p>
                  <label className="file-input file-input--compact">
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      disabled={uploadDisabled}
                      onChange={(event) => {
                        const selectedFile = event.target.files?.[0] ?? null
                        void handleFileSelected(selectedFile)
                        event.currentTarget.value = ''
                      }}
                    />
                    <span>{uploadBusy ? 'Subiendo...' : 'Cambiar archivo'}</span>
                  </label>
                </aside>
              ) : null}

              <section className="progress-grid">
                {progress.map((item) => {
                  const ratio = item.total === 0 ? 0 : (item.operated / item.minimumRequired) * 100
                  const progressPercent = Math.max(0, Math.min(100, Number.isFinite(ratio) ? ratio : 0))
                  return (
                    <article
                      key={item.category}
                      className={item.achieved ? 'progress-card progress-card--achieved' : 'progress-card'}
                    >
                      <h3>{item.category}</h3>
                      <p className="progress-card__numbers">
                        {item.operated} / {item.minimumRequired} min ({item.total} totales)
                      </p>
                      <div className="meter" aria-hidden="true">
                        <span style={{ width: `${progressPercent}%` }} />
                      </div>
                      <p className="progress-card__meta">
                        Objetivo {item.targetPercent}% · Operado {item.operatedPercent.toFixed(1)}% · Restan {item.remaining}
                      </p>
                    </article>
                  )
                })}
              </section>

              <section className="table-card">
                <div className="table-toolbar">
                  <div className="toolbar-main">
                    <strong>
                      {totalOperated} operados de {flights.length}
                    </strong>
                    <span>{loadingDataset ? 'Cargando dataset...' : `${filteredFlights.length} vuelos visibles`}</span>
                  </div>
                  <div className="toolbar-filters">
                    <input
                      type="search"
                      value={query}
                      placeholder="Buscar por vuelo, compania o hora"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                      <option value="all">Todas las categorias</option>
                      {categories.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Operado</th>
                        <th>Hora</th>
                        <th>Compania</th>
                        <th>Vuelo</th>
                        <th>Tipo</th>
                        <th>Categoria</th>
                        <th>Marcado por</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleFlights.map((flight) => (
                        <tr key={flight.id} className={flight.operated ? 'row-operated' : ''}>
                          <td>
                            <button
                              type="button"
                              className={flight.operated ? 'operate-btn operate-btn--locked' : 'operate-btn'}
                              disabled={flight.operated || markBusy}
                              onClick={() => handleOpenMarkModal(flight)}
                            >
                              {flight.operated ? 'Operado' : 'Marcar'}
                            </button>
                          </td>
                          <td>
                            {flight.fecha} {flight.hora}
                          </td>
                          <td>
                            <span className="cell-code">{flight.cia}</span> {flight.dscia}
                          </td>
                          <td>{flight.vuelo}</td>
                          <td>{flight.tipo}</td>
                          <td>{flight.categoriaClasificacion}</td>
                          <td>
                            {flight.operatedByEmail ?? '--'}
                            <small>{formatDateTime(flight.operatedAt)}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="pagination">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    disabled={currentPageSafe <= 1}
                  >
                    Anterior
                  </button>
                  <span>
                    Pagina {currentPageSafe} de {totalPages}
                  </span>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    disabled={currentPageSafe >= totalPages}
                  >
                    Siguiente
                  </button>
                </div>
              </section>
            </>
          )}
        </>
      )}

      {confirmFlight ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setConfirmFlight(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h2>Confirmar vuelo operado</h2>
            <p>
              Vas a marcar como <strong>operado</strong> el vuelo <strong>{confirmFlight.vuelo}</strong> de{' '}
              <strong>{confirmFlight.dscia}</strong>.
            </p>
            <p>Esta accion es irreversible. Un vuelo operado no puede desmarcarse.</p>
            <div className="modal-actions">
              <button type="button" className="secondary-btn" onClick={() => setConfirmFlight(null)} disabled={markBusy}>
                Cancelar
              </button>
              <button type="button" onClick={() => void handleConfirmMarkOperated()} disabled={markBusy}>
                {markBusy ? 'Confirmando...' : 'Confirmar operado'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
