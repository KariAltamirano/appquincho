# App Quincho

Web app responsive en React para registrar presupuesto, materiales, pagos de mano de obra y documentos del proyecto de construcción de quincho.

## Funcionalidades

- Dashboard con presupuesto editable, gasto acumulado, diferencia y barra de progreso.
- CRUD de documentos (planos, recibos y comprobantes) con filtro por categoría.
- Integración de subida a Google Drive (carpeta raíz y subcarpetas por categoría).
- CRUD de materiales con estado, subtotal por ítem y tag de `extra`.
- CRUD de pagos a albañiles con total acumulado.
- Planilla general de gastos consolidada (materiales + mano de obra), destacando extras.
- Exportación de gastos a CSV.
- Gráfico simple de gasto acumulado en el tiempo.

## Persistencia

Los datos se guardan en `window.storage` bajo la clave `quincho.project.data.v1`.

## Integración Google Drive

La app intenta subir archivos a la carpeta:

`https://drive.google.com/drive/folders/1TWXSkbYwu9SvYu3KL3diqOfOFTZYn96e`

Requiere sesión autenticada de Google Drive en frontend:

- `window.gapi.client.getToken()` con `access_token`, o
- `window.driveAccessToken`

Si no hay token válido, la app muestra error y permite guardar manualmente un enlace de Drive.

## Desarrollo

```bash
npm install
npm run dev
```

## Validación

```bash
npm run build
npm run lint
```
