# SSMM Flight Tracker

Web operativa para control de vuelos protegidos por categoria (5.3, 5.4, 5.5, 5.6), con dos modos:

- `Supabase realtime`: sincronizacion entre operadores, OTP por email permitido y trazabilidad.
- `Guest test`: pruebas de frontend en local sin sincronizacion.

## Funcionalidades clave

- Carga CSV con validacion de campos minimos:
  - `CATEGORIA_CLASIFICACION`, `tipo`, `FECHA`, `HORA`, `CÍA`, `DSCIA`, `CDOCIA`, `VUELO`
- Banner compacto (siempre disponible) con todos los parametros:
  - CSV activo
  - selector de dia (solo dias detectados en el CSV cargado)
  - porcentajes por categoria
- Al seleccionar dia, la tabla y los calculos se filtran a ese dia.
- Configuracion bloqueable: al guardar, sliders y fecha quedan desactivados y el boton pasa a `Modificar`.
- Marcado de vuelo `Operado` con modal de confirmacion (irreversible).
- Progreso por categoria en tiempo real: `operados / minimo exigido`.
- OTP solo para emails admitidos en `public.allowed_emails`.

## Puesta en marcha

1. Instala dependencias:

```bash
npm install
```

2. Crea variables locales (`.env` o `.env.local`) a partir de `.env.example`.

3. Arranca desarrollo:

```bash
npm run dev
```

4. Build de verificacion:

```bash
npm run build
```

## Configuracion de Supabase

1. Abre SQL Editor en tu proyecto Supabase.
2. Ejecuta `supabase/schema.sql`.
3. Si el proyecto ya estaba creado antes de `dataset_settings`, pega y ejecuta tambien el SQL de:

- `supabase/migrations/20260221_add_dataset_settings.sql`

4. Inserta los emails autorizados:

```sql
insert into public.allowed_emails (email, active)
values
  ('operador1@empresa.com', true),
  ('operador2@empresa.com', true)
on conflict (email) do update set active = excluded.active;
```

5. Activa Email OTP en `Authentication > Providers > Email`.

## Deploy en Netlify

Variables de entorno necesarias en Netlify:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Si Netlify bloquea el build por secrets scanning en variables `VITE_*` (esperado en frontend), este repo incluye `netlify.toml` con:

- `SECRETS_SCAN_OMIT_KEYS=VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY`

No pongas en frontend:

- `SUPABASE_SECRET_KEY`
- `GITHUB_PAT`

Configura en Supabase `Authentication > URL Configuration`:

- `Site URL`: URL publica de Netlify
- `Redirect URLs`: URL publica de Netlify (y previews si aplican)

## Nota de seguridad

- No subas `.env` ni `.env.local` al repositorio.
- Usa `VITE_SUPABASE_ANON_KEY` solo en frontend.
- Mantén `SUPABASE_SECRET_KEY` para operaciones de administracion fuera del cliente.
