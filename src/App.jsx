import { useEffect, useMemo, useState } from 'react'
import './App.css'

const STORAGE_KEY = 'quincho.project.data.v1'
const DRIVE_ROOT_URL = import.meta.env.VITE_DRIVE_ROOT_URL || ''
const DOCUMENT_CATEGORIES = ['Planos', 'Recibos de materiales', 'Comprobantes de pago']

const currencyFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
})

const todayISO = () => new Date().toISOString().slice(0, 10)

const makeId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).replace('0.', '').slice(0, 8)}`

const defaultData = {
  budget: 0,
  materials: [],
  payments: [],
  documents: [],
}

const parseNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const getStore = () => (typeof window !== 'undefined' ? window.storage : undefined)

const readStorageValue = async (key) => {
  const store = getStore()
  if (!store) return null
  if (typeof store.getItem === 'function') return await Promise.resolve(store.getItem(key))
  if (typeof store.get === 'function') return await Promise.resolve(store.get(key))
  return null
}

const writeStorageValue = async (key, value) => {
  const store = getStore()
  if (!store) return
  if (typeof store.setItem === 'function') {
    await Promise.resolve(store.setItem(key, value))
    return
  }
  if (typeof store.set === 'function') {
    await Promise.resolve(store.set(key, value))
  }
}

const formatCurrency = (value) => currencyFormatter.format(Number(value) || 0)

const toDateValue = (value) => new Date(`${value || '1970-01-01'}T00:00:00`).getTime()

const initialMaterialForm = {
  id: null,
  name: '',
  date: todayISO(),
  neededQty: '',
  purchasedQty: '',
  estimatedUnitPrice: '',
  realUnitPrice: '',
  status: 'pendiente',
  isExtra: false,
}

const initialPaymentForm = {
  id: null,
  date: todayISO(),
  worker: '',
  concept: '',
  amount: '',
  receiptName: '',
  driveLink: '',
}

const initialDocumentForm = {
  id: null,
  name: '',
  category: DOCUMENT_CATEGORIES[0],
  date: todayISO(),
  description: '',
  driveLink: '',
}

const getDriveRootId = () => {
  if (!DRIVE_ROOT_URL) return ''
  const matched = DRIVE_ROOT_URL.match(/folders\/([^/?]+)/)
  return matched?.[1] || ''
}

const getDriveToken = () => {
  const tokenFromGapi =
    typeof window !== 'undefined' && window.gapi?.client?.getToken
      ? window.gapi.client.getToken()?.access_token
      : null
  const tokenFromWindow = typeof window !== 'undefined' ? window.driveAccessToken : null
  return tokenFromGapi || tokenFromWindow || null
}

const escapeDriveQueryValue = (value) => String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")

const createOrFindDriveFolder = async (token, parentFolderId, folderName) => {
  const safeParentFolderId = escapeDriveQueryValue(parentFolderId)
  const safeFolderName = escapeDriveQueryValue(folderName)
  const query = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and trashed=false and '${safeParentFolderId}' in parents and name='${safeFolderName}'`,
  )

  const searchResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`,
    {
      headers: {
        Authorization: ['Bearer', token].join(' '),
      },
    },
  )

  if (!searchResponse.ok) {
    throw new Error('No se pudo consultar Google Drive.')
  }

  const searchResult = await searchResponse.json()
  if (searchResult.files?.length) return searchResult.files[0].id

  const createResponse = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: ['Bearer', token].join(' '),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    }),
  })

  if (!createResponse.ok) {
    throw new Error('No se pudo crear la subcarpeta en Google Drive.')
  }

  const created = await createResponse.json()
  return created.id
}

const uploadDocumentToDrive = async (file, category) => {
  const token = getDriveToken()
  if (!token) {
    throw new Error(
      'No hay sesión autenticada de Google Drive disponible. Configurá gapi o window.driveAccessToken.',
    )
  }

  const rootId = getDriveRootId()
  if (!rootId) throw new Error('No se encontró el ID de la carpeta raíz de Google Drive.')

  const categoryFolderId = await createOrFindDriveFolder(token, rootId, category)

  const boundary = `quincho-${Date.now().toString(36)}`
  const metadata = {
    name: file.name,
    parents: [categoryFolderId],
  }

  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
      file,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  )

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: ['Bearer', token].join(' '),
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )

  if (!response.ok) {
    throw new Error('Error al subir el archivo a Google Drive.')
  }

  const uploaded = await response.json()
  return {
    name: uploaded.name || file.name,
    link: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
  }
}

function App() {
  const [data, setData] = useState(defaultData)
  const [isLoaded, setIsLoaded] = useState(false)
  const [storageMessage, setStorageMessage] = useState('')

  const [budgetInput, setBudgetInput] = useState('0')

  const [materialForm, setMaterialForm] = useState(initialMaterialForm)
  const [paymentForm, setPaymentForm] = useState(initialPaymentForm)
  const [documentForm, setDocumentForm] = useState(initialDocumentForm)

  const [documentFilter, setDocumentFilter] = useState('todos')
  const [selectedDocumentFile, setSelectedDocumentFile] = useState(null)
  const [isUploadingDrive, setIsUploadingDrive] = useState(false)
  const [driveError, setDriveError] = useState('')

  useEffect(() => {
    const loadData = async () => {
      try {
        const raw = await readStorageValue(STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          const hydrated = {
            ...defaultData,
            ...parsed,
            materials: Array.isArray(parsed.materials) ? parsed.materials : [],
            payments: Array.isArray(parsed.payments) ? parsed.payments : [],
            documents: Array.isArray(parsed.documents) ? parsed.documents : [],
          }
          setData(hydrated)
          setBudgetInput(String(hydrated.budget || 0))
        } else {
          setBudgetInput('0')
        }
        setStorageMessage(getStore() ? '' : 'window.storage no está disponible en este navegador.')
      } catch {
        setStorageMessage('No se pudieron recuperar los datos guardados.')
      } finally {
        setIsLoaded(true)
      }
    }

    loadData()
  }, [])

  const persistAndSetData = (updater) => {
    setData((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater
      writeStorageValue(STORAGE_KEY, JSON.stringify(next)).catch(() => {
        setStorageMessage('No se pudieron guardar los cambios en window.storage.')
      })
      return next
    })
  }

  const materialsTotal = useMemo(
    () =>
      data.materials.reduce((sum, item) => {
        const unit = parseNumber(item.realUnitPrice) || parseNumber(item.estimatedUnitPrice)
        return sum + unit * parseNumber(item.purchasedQty)
      }, 0),
    [data.materials],
  )

  const laborTotal = useMemo(
    () => data.payments.reduce((sum, item) => sum + parseNumber(item.amount), 0),
    [data.payments],
  )

  const allExpenses = useMemo(() => {
    const materialRows = data.materials.map((item) => {
      const unit = parseNumber(item.realUnitPrice) || parseNumber(item.estimatedUnitPrice)
      const subtotal = unit * parseNumber(item.purchasedQty)
      return {
        id: `material-${item.id}`,
        date: item.date || todayISO(),
        category: item.isExtra ? 'extra' : 'material',
        description: item.name,
        amount: subtotal,
      }
    })

    const paymentRows = data.payments.map((item) => ({
      id: `payment-${item.id}`,
      date: item.date || todayISO(),
      category: 'mano de obra',
      description: `${item.worker} · ${item.concept}`,
      amount: parseNumber(item.amount),
    }))

    return [...materialRows, ...paymentRows].sort((a, b) => toDateValue(b.date) - toDateValue(a.date))
  }, [data.materials, data.payments])

  const totalSpent = materialsTotal + laborTotal
  const budgetDifference = parseNumber(data.budget) - totalSpent
  const progressPercent = parseNumber(data.budget) > 0 ? Math.min((totalSpent / data.budget) * 100, 100) : 0
  const extraSpent = allExpenses
    .filter((item) => item.category === 'extra')
    .reduce((sum, item) => sum + parseNumber(item.amount), 0)

  const recentMovements = allExpenses.slice(0, 5)

  const filteredDocuments =
    documentFilter === 'todos'
      ? data.documents
      : data.documents.filter((item) => item.category === documentFilter)

  const timelineSeries = useMemo(() => {
    const ordered = [...allExpenses].sort((a, b) => toDateValue(a.date) - toDateValue(b.date))
    return ordered.reduce((acc, entry) => {
      const previous = acc.length ? acc[acc.length - 1].total : 0
      return [...acc, { date: entry.date, total: previous + parseNumber(entry.amount) }]
    }, [])
  }, [allExpenses])

  const onSaveBudget = (event) => {
    event.preventDefault()
    const value = parseNumber(budgetInput)
    persistAndSetData((current) => ({ ...current, budget: value }))
  }

  const onSubmitMaterial = (event) => {
    event.preventDefault()
    const payload = {
      ...materialForm,
      id: materialForm.id || makeId(),
      neededQty: parseNumber(materialForm.neededQty),
      purchasedQty: parseNumber(materialForm.purchasedQty),
      estimatedUnitPrice: parseNumber(materialForm.estimatedUnitPrice),
      realUnitPrice: parseNumber(materialForm.realUnitPrice),
    }

    persistAndSetData((current) => {
      const materials = materialForm.id
        ? current.materials.map((item) => (item.id === materialForm.id ? payload : item))
        : [payload, ...current.materials]
      return { ...current, materials }
    })

    setMaterialForm(initialMaterialForm)
  }

  const onEditMaterial = (item) => {
    setMaterialForm({
      id: item.id,
      name: item.name,
      date: item.date || todayISO(),
      neededQty: String(item.neededQty ?? ''),
      purchasedQty: String(item.purchasedQty ?? ''),
      estimatedUnitPrice: String(item.estimatedUnitPrice ?? ''),
      realUnitPrice: String(item.realUnitPrice ?? ''),
      status: item.status || 'pendiente',
      isExtra: Boolean(item.isExtra),
    })
  }

  const onDeleteMaterial = (id) => {
    persistAndSetData((current) => ({
      ...current,
      materials: current.materials.filter((item) => item.id !== id),
    }))
  }

  const onSubmitPayment = (event) => {
    event.preventDefault()
    const payload = {
      ...paymentForm,
      id: paymentForm.id || makeId(),
      amount: parseNumber(paymentForm.amount),
    }

    persistAndSetData((current) => {
      const payments = paymentForm.id
        ? current.payments.map((item) => (item.id === paymentForm.id ? payload : item))
        : [payload, ...current.payments]
      return { ...current, payments }
    })

    setPaymentForm(initialPaymentForm)
  }

  const onEditPayment = (item) => {
    setPaymentForm({
      id: item.id,
      date: item.date || todayISO(),
      worker: item.worker || '',
      concept: item.concept || '',
      amount: String(item.amount ?? ''),
      receiptName: item.receiptName || '',
      driveLink: item.driveLink || '',
    })
  }

  const onDeletePayment = (id) => {
    persistAndSetData((current) => ({
      ...current,
      payments: current.payments.filter((item) => item.id !== id),
    }))
  }

  const onSubmitDocument = (event) => {
    event.preventDefault()
    const payload = {
      ...documentForm,
      id: documentForm.id || makeId(),
    }

    persistAndSetData((current) => {
      const documents = documentForm.id
        ? current.documents.map((item) => (item.id === documentForm.id ? payload : item))
        : [payload, ...current.documents]
      return { ...current, documents }
    })

    setDocumentForm(initialDocumentForm)
    setSelectedDocumentFile(null)
  }

  const onEditDocument = (item) => {
    setDocumentForm({
      id: item.id,
      name: item.name || '',
      category: item.category || DOCUMENT_CATEGORIES[0],
      date: item.date || todayISO(),
      description: item.description || '',
      driveLink: item.driveLink || '',
    })
  }

  const onDeleteDocument = (id) => {
    persistAndSetData((current) => ({
      ...current,
      documents: current.documents.filter((item) => item.id !== id),
    }))
  }

  const onUploadToDrive = async () => {
    if (!selectedDocumentFile) {
      setDriveError('Seleccioná un archivo antes de subir.')
      return
    }

    setDriveError('')
    setIsUploadingDrive(true)

    try {
      const uploaded = await uploadDocumentToDrive(selectedDocumentFile, documentForm.category)
      setDocumentForm((current) => ({
        ...current,
        name: uploaded.name,
        driveLink: uploaded.link,
      }))
    } catch (error) {
      setDriveError(error instanceof Error ? error.message : 'No se pudo subir a Google Drive.')
    } finally {
      setIsUploadingDrive(false)
    }
  }

  const exportExpensesCsv = () => {
    const header = ['Fecha', 'Categoría', 'Descripción', 'Monto']
    const rows = allExpenses.map((item) => [
      item.date,
      item.category,
      item.description,
      String(item.amount).replace('.', ','),
    ])

    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
      .join('\r\n')

    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'gastos-quincho.csv'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 250)
  }

  const maxTimeline = timelineSeries.length
    ? Math.max(...timelineSeries.map((item) => item.total), 1)
    : 1

  if (!isLoaded) {
    return <main className="app"><p>Cargando datos…</p></main>
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Registro de Proyecto Quincho</h1>
        <p>Control de presupuesto, materiales, pagos y documentos de obra.</p>
        {DRIVE_ROOT_URL ? (
          <a href={DRIVE_ROOT_URL} target="_blank" rel="noreferrer" className="drive-link">
            Carpeta principal de Google Drive
          </a>
        ) : (
          <p className="warning">Definí VITE_DRIVE_ROOT_URL para habilitar carga automática a Drive.</p>
        )}
        {storageMessage ? <p className="warning">{storageMessage}</p> : null}
      </header>

      <section className="card">
        <div className="card-title-row">
          <h2>Dashboard / Resumen inicial</h2>
        </div>

        <form className="inline-form" onSubmit={onSaveBudget}>
          <label>
            Presupuesto inicial total
            <input
              type="number"
              min="0"
              value={budgetInput}
              onChange={(event) => setBudgetInput(event.target.value)}
            />
          </label>
          <button type="submit">Guardar presupuesto</button>
        </form>

        <div className="metrics-grid">
          <article>
            <span>Presupuesto inicial</span>
            <strong>{formatCurrency(data.budget)}</strong>
          </article>
          <article>
            <span>Gasto acumulado</span>
            <strong>{formatCurrency(totalSpent)}</strong>
          </article>
          <article>
            <span>Diferencia</span>
            <strong className={budgetDifference >= 0 ? 'positive' : 'negative'}>
              {formatCurrency(budgetDifference)}
            </strong>
          </article>
          <article>
            <span>Total en extras</span>
            <strong className="negative">{formatCurrency(extraSpent)}</strong>
          </article>
        </div>

        <div className="progress-box" aria-label="Barra de progreso del gasto">
          <div className="progress-bar" style={{ width: `${progressPercent}%` }}></div>
        </div>
        <small>{progressPercent.toFixed(1)}% del presupuesto utilizado</small>

        <h3>Últimos movimientos</h3>
        <ul className="recent-list">
          {recentMovements.length ? (
            recentMovements.map((item) => (
              <li key={item.id}>
                <span>{item.date}</span>
                <span>{item.description}</span>
                <strong className={item.category === 'extra' ? 'tag-extra' : ''}>
                  {formatCurrency(item.amount)}
                </strong>
              </li>
            ))
          ) : (
            <li>Sin movimientos cargados.</li>
          )}
        </ul>
      </section>

      <section className="card">
        <h2>Documentos</h2>

        <form className="grid-form" onSubmit={onSubmitDocument}>
          <label>
            Nombre
            <input
              value={documentForm.name}
              onChange={(event) => setDocumentForm((prev) => ({ ...prev, name: event.target.value }))}
              required
            />
          </label>
          <label>
            Categoría
            <select
              value={documentForm.category}
              onChange={(event) =>
                setDocumentForm((prev) => ({ ...prev, category: event.target.value }))
              }
            >
              {DOCUMENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fecha
            <input
              type="date"
              value={documentForm.date}
              onChange={(event) => setDocumentForm((prev) => ({ ...prev, date: event.target.value }))}
              required
            />
          </label>
          <label>
            Descripción (opcional)
            <input
              value={documentForm.description}
              onChange={(event) =>
                setDocumentForm((prev) => ({ ...prev, description: event.target.value }))
              }
            />
          </label>
          <label>
            Link de Google Drive
            <input
              type="url"
              value={documentForm.driveLink}
              onChange={(event) =>
                setDocumentForm((prev) => ({ ...prev, driveLink: event.target.value }))
              }
              placeholder="https://drive.google.com/..."
            />
          </label>
          <label>
            Archivo
            <input
              type="file"
              onChange={(event) => {
                const selected = event.target.files?.[0] || null
                setSelectedDocumentFile(selected)
                if (selected) {
                  setDocumentForm((prev) => ({ ...prev, name: prev.name || selected.name }))
                }
              }}
            />
          </label>
          <div className="actions-row">
            <button type="button" onClick={onUploadToDrive} disabled={isUploadingDrive}>
              {isUploadingDrive ? 'Subiendo…' : 'Subir a Google Drive'}
            </button>
            <button type="submit">{documentForm.id ? 'Actualizar documento' : 'Guardar documento'}</button>
            {documentForm.id ? (
              <button type="button" onClick={() => setDocumentForm(initialDocumentForm)}>
                Cancelar edición
              </button>
            ) : null}
          </div>
        </form>
        {driveError ? <p className="warning">{driveError}</p> : null}

        <div className="filter-row">
          <label>
            Filtrar por categoría
            <select value={documentFilter} onChange={(event) => setDocumentFilter(event.target.value)}>
              <option value="todos">Todos</option>
              {DOCUMENT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Categoría</th>
                <th>Fecha</th>
                <th>Descripción</th>
                <th>Archivo</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredDocuments.length ? (
                filteredDocuments.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.category}</td>
                    <td>{item.date}</td>
                    <td>{item.description || '-'}</td>
                    <td>
                      {item.driveLink ? (
                        <a href={item.driveLink} target="_blank" rel="noreferrer">
                          Ver
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="actions-cell">
                      <button type="button" onClick={() => onEditDocument(item)}>
                        Editar
                      </button>
                      <button type="button" onClick={() => onDeleteDocument(item.id)}>
                        Borrar
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="6">No hay documentos para el filtro seleccionado.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Lista de materiales</h2>

        <form className="grid-form" onSubmit={onSubmitMaterial}>
          <label>
            Nombre del material
            <input
              value={materialForm.name}
              onChange={(event) => setMaterialForm((prev) => ({ ...prev, name: event.target.value }))}
              required
            />
          </label>
          <label>
            Fecha
            <input
              type="date"
              value={materialForm.date}
              onChange={(event) => setMaterialForm((prev) => ({ ...prev, date: event.target.value }))}
              required
            />
          </label>
          <label>
            Cantidad necesaria
            <input
              type="number"
              min="0"
              step="0.01"
              value={materialForm.neededQty}
              onChange={(event) =>
                setMaterialForm((prev) => ({ ...prev, neededQty: event.target.value }))
              }
              required
            />
          </label>
          <label>
            Cantidad comprada
            <input
              type="number"
              min="0"
              step="0.01"
              value={materialForm.purchasedQty}
              onChange={(event) =>
                setMaterialForm((prev) => ({ ...prev, purchasedQty: event.target.value }))
              }
              required
            />
          </label>
          <label>
            Precio unitario estimado
            <input
              type="number"
              min="0"
              step="0.01"
              value={materialForm.estimatedUnitPrice}
              onChange={(event) =>
                setMaterialForm((prev) => ({ ...prev, estimatedUnitPrice: event.target.value }))
              }
            />
          </label>
          <label>
            Precio real pagado
            <input
              type="number"
              min="0"
              step="0.01"
              value={materialForm.realUnitPrice}
              onChange={(event) =>
                setMaterialForm((prev) => ({ ...prev, realUnitPrice: event.target.value }))
              }
            />
          </label>
          <label>
            Estado
            <select
              value={materialForm.status}
              onChange={(event) => setMaterialForm((prev) => ({ ...prev, status: event.target.value }))}
            >
              <option value="pendiente">pendiente</option>
              <option value="comprado">comprado</option>
              <option value="parcial">parcial</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={materialForm.isExtra}
              onChange={(event) => setMaterialForm((prev) => ({ ...prev, isExtra: event.target.checked }))}
            />
            Marcar como extra / no planificado
          </label>
          <div className="actions-row">
            <button type="submit">{materialForm.id ? 'Actualizar material' : 'Guardar material'}</button>
            {materialForm.id ? (
              <button type="button" onClick={() => setMaterialForm(initialMaterialForm)}>
                Cancelar edición
              </button>
            ) : null}
          </div>
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th>Fecha</th>
                <th>Cant. necesaria</th>
                <th>Cant. comprada</th>
                <th>Estimado unitario</th>
                <th>Real unitario</th>
                <th>Estado</th>
                <th>Subtotal</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.materials.length ? (
                data.materials.map((item) => {
                  const unit = parseNumber(item.realUnitPrice) || parseNumber(item.estimatedUnitPrice)
                  const subtotal = unit * parseNumber(item.purchasedQty)

                  return (
                    <tr key={item.id}>
                      <td>
                        {item.name}
                        {item.isExtra ? <span className="pill">extra</span> : null}
                      </td>
                      <td>{item.date}</td>
                      <td>{item.neededQty}</td>
                      <td>{item.purchasedQty}</td>
                      <td>{formatCurrency(item.estimatedUnitPrice)}</td>
                      <td>{formatCurrency(item.realUnitPrice)}</td>
                      <td>{item.status}</td>
                      <td>{formatCurrency(subtotal)}</td>
                      <td className="actions-cell">
                        <button type="button" onClick={() => onEditMaterial(item)}>
                          Editar
                        </button>
                        <button type="button" onClick={() => onDeleteMaterial(item.id)}>
                          Borrar
                        </button>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan="9">No hay materiales cargados.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="total-line">Total materiales: {formatCurrency(materialsTotal)}</p>
      </section>

      <section className="card">
        <h2>Pagos a albañiles</h2>

        <form className="grid-form" onSubmit={onSubmitPayment}>
          <label>
            Fecha
            <input
              type="date"
              value={paymentForm.date}
              onChange={(event) => setPaymentForm((prev) => ({ ...prev, date: event.target.value }))}
              required
            />
          </label>
          <label>
            Albañil / contratista
            <input
              value={paymentForm.worker}
              onChange={(event) => setPaymentForm((prev) => ({ ...prev, worker: event.target.value }))}
              required
            />
          </label>
          <label>
            Concepto
            <input
              value={paymentForm.concept}
              onChange={(event) => setPaymentForm((prev) => ({ ...prev, concept: event.target.value }))}
              required
            />
          </label>
          <label>
            Monto
            <input
              type="number"
              min="0"
              step="0.01"
              value={paymentForm.amount}
              onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))}
              required
            />
          </label>
          <label>
            Nombre de comprobante
            <input
              value={paymentForm.receiptName}
              onChange={(event) =>
                setPaymentForm((prev) => ({ ...prev, receiptName: event.target.value }))
              }
            />
          </label>
          <label>
            Link de comprobante (Drive)
            <input
              type="url"
              value={paymentForm.driveLink}
              onChange={(event) => setPaymentForm((prev) => ({ ...prev, driveLink: event.target.value }))}
              placeholder="https://drive.google.com/..."
            />
          </label>
          <div className="actions-row">
            <button type="submit">{paymentForm.id ? 'Actualizar pago' : 'Guardar pago'}</button>
            {paymentForm.id ? (
              <button type="button" onClick={() => setPaymentForm(initialPaymentForm)}>
                Cancelar edición
              </button>
            ) : null}
          </div>
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Albañil/Contratista</th>
                <th>Concepto</th>
                <th>Monto</th>
                <th>Comprobante</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.payments.length ? (
                data.payments.map((item) => (
                  <tr key={item.id}>
                    <td>{item.date}</td>
                    <td>{item.worker}</td>
                    <td>{item.concept}</td>
                    <td>{formatCurrency(item.amount)}</td>
                    <td>
                      {item.driveLink ? (
                        <a href={item.driveLink} target="_blank" rel="noreferrer">
                          {item.receiptName || 'Ver comprobante'}
                        </a>
                      ) : (
                        item.receiptName || '-'
                      )}
                    </td>
                    <td className="actions-cell">
                      <button type="button" onClick={() => onEditPayment(item)}>
                        Editar
                      </button>
                      <button type="button" onClick={() => onDeletePayment(item.id)}>
                        Borrar
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="6">No hay pagos cargados.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="total-line">Total mano de obra: {formatCurrency(laborTotal)}</p>
      </section>

      <section className="card">
        <div className="card-title-row">
          <h2>Planilla de gastos general</h2>
          <button type="button" onClick={exportExpensesCsv}>
            Exportar CSV
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Categoría</th>
                <th>Descripción</th>
                <th>Monto</th>
              </tr>
            </thead>
            <tbody>
              {allExpenses.length ? (
                allExpenses.map((item) => (
                  <tr key={item.id} className={item.category === 'extra' ? 'row-extra' : ''}>
                    <td>{item.date}</td>
                    <td>{item.category}</td>
                    <td>{item.description}</td>
                    <td>{formatCurrency(item.amount)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="4">No hay gastos cargados.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="total-line">Total general: {formatCurrency(totalSpent)}</p>
        <p className="total-line">Comparación contra presupuesto: {formatCurrency(budgetDifference)}</p>
      </section>

      <section className="card">
        <h2>Gasto acumulado en el tiempo</h2>
        {timelineSeries.length ? (
          <svg
            className="chart"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            role="img"
            aria-label="Gráfico de gasto acumulado en el tiempo"
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              points={timelineSeries
                .map((item, index) => {
                  const x = timelineSeries.length === 1 ? 50 : (index / (timelineSeries.length - 1)) * 100
                  const y = 38 - (item.total / maxTimeline) * 34
                  return `${x},${Math.max(2, y)}`
                })
                .join(' ')}
            />
          </svg>
        ) : (
          <p>Cargá gastos para ver el gráfico.</p>
        )}
      </section>
    </main>
  )
}

export default App
